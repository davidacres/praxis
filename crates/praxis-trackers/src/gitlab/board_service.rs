//! GitLab issue boards as Praxis boards (`gitlab/gitLabBoardService.ts` port).
//!
//! Unlike GitHub, GitLab has real boards: each board's lists (label, assignee, milestone or
//! iteration lists) become columns between an optional Backlog and an optional Closed
//! column, and an issue's column is the first list it matches. Moving a card rewrites the
//! labels, assignees, milestone or iteration that put it in its list.
//!
//! A board must be loaded before its cards can move: loading records each issue's board
//! context (keyed by issue key) until [`reset`]. The API config is cached the same way. Both
//! sit behind a `std::sync::Mutex` that is never held across an await.
//!
//! [`reset`]: IssueTrackerService::reset

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use async_trait::async_trait;
use praxis_contracts::{
    BackendMode, Board, BoardColumn, BoardDetails, BoardFilters, ConnectionCheck,
    ConnectionCheckStatus, CreateBoardInput, CreateIssueInput, FilterMetadata, IssueAttachment,
    IssueComment, IssueDetails, IssueFilters, IssueSummary, PagedIssues, ParentItemQueryOptions,
    Project, UpdateBoardInput, UpdateIssueInput, WorkflowTransition,
};
use regex::Regex;
use reqwest::Client;
use serde_json::Value;

use crate::gitlab::api_service::{
    CreateGitLabIssueInput, GitLabApiConfig, GitLabApiService, GitLabBoard, GitLabBoardList,
    GitLabBoardListKind, GitLabIssue, GitLabIssueComment, GitLabIssueListFilters,
    GitLabIssueStateFilter, GitLabProject, GitLabProjectRef, GitLabStateEvent, GitLabUser,
    UpdateGitLabIssueInput,
};
use crate::gitlab::config_store::{GitLabBoardServiceOptions, GitLabConfigStore};
use crate::issue_tracker_service::{IssueTrackerService, LogSink, TrackerResult};
use crate::rest_support::{
    filter_metadata_of, matches_board_filters, matches_issue_filters, page_sorted_issues,
    resolve_api_token, unsupported_issue_edit_fields,
};

const ATTACHMENTS_UNSUPPORTED: &str = "GitLab mode does not support attachments. Add files as links in the issue description or a comment instead.";
const ISSUE_CREATION_DISABLED_ERROR: &str = "Issue creation is disabled for this GitLab connection. Enable it on the connection to create GitLab issues.";

/// The board an issue was last loaded on, for resolving its column and transitions.
#[derive(Debug, Clone)]
struct GitLabBoardContext {
    board: GitLabBoard,
    lists: Vec<GitLabBoardList>,
}

/// One `group/project::<boardId>` entry of the connection's board selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitLabSelectedBoardRef {
    pub project_path: String,
    pub board_id: u64,
}

/// `group/project::<boardId>`.
#[must_use]
pub fn build_gitlab_selected_board_ref(project_path: &str, board_id: u64) -> String {
    format!("{}::{board_id}", project_path.trim())
}

#[must_use]
pub fn parse_gitlab_selected_board_ref(value: &str) -> Option<GitLabSelectedBoardRef> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN
        .get_or_init(|| Regex::new(r"^(.*)::(\d+)$").expect("the selected board pattern is valid"));
    let captures = pattern.captures(value.trim())?;
    let project_path = captures[1].trim();
    let board_id = captures[2].parse().ok()?;
    (!project_path.is_empty()).then(|| GitLabSelectedBoardRef {
        project_path: project_path.to_string(),
        board_id,
    })
}

/// The project path and issue iid of a `group/project#7` key.
pub fn parse_gitlab_issue_key(issue_key: &str) -> TrackerResult<(String, u64)> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN
        .get_or_init(|| Regex::new(r"^(.+)#(\d+)$").expect("the issue key pattern is valid"));
    pattern
        .captures(issue_key.trim())
        .and_then(|captures| {
            let iid = captures[2].parse().ok()?;
            Some((captures[1].to_string(), iid))
        })
        .ok_or_else(|| format!("Invalid GitLab issue key: {issue_key}"))
}

fn backlog_column(board: &GitLabBoard) -> BoardColumn {
    BoardColumn {
        id: format!("{}:backlog", board.id),
        name: "Backlog".to_string(),
        status_category: Some("todo".to_string()),
        issues: Vec::new(),
    }
}

fn closed_column(board: &GitLabBoard) -> BoardColumn {
    BoardColumn {
        id: format!("{}:closed", board.id),
        name: "Closed".to_string(),
        status_category: Some("done".to_string()),
        issues: Vec::new(),
    }
}

fn list_column(board: &GitLabBoard, list: &GitLabBoardList) -> BoardColumn {
    BoardColumn {
        id: format!("{}:list:{}", board.id, list.id),
        name: list.title.clone(),
        status_category: None,
        issues: Vec::new(),
    }
}

fn build_board_columns(board: &GitLabBoard, lists: &[GitLabBoardList]) -> Vec<BoardColumn> {
    let mut columns = Vec::new();
    if !board.hide_backlog_list {
        columns.push(backlog_column(board));
    }
    columns.extend(lists.iter().map(|list| list_column(board, list)));
    if !board.hide_closed_list {
        columns.push(closed_column(board));
    }
    columns
}

fn normalized(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_lowercase()
}

fn has_label(issue: &GitLabIssue, label: &str) -> bool {
    let wanted = normalized(Some(label));
    issue
        .labels
        .iter()
        .any(|issue_label| normalized(Some(issue_label)) == wanted)
}

fn matches_board_list(issue: &GitLabIssue, list: &GitLabBoardList) -> bool {
    match (list.kind, list) {
        (
            Some(GitLabBoardListKind::Label),
            GitLabBoardList {
                label_name: Some(label),
                ..
            },
        ) if !label.is_empty() => has_label(issue, label),
        (
            Some(GitLabBoardListKind::Assignee),
            GitLabBoardList {
                assignee_username: Some(username),
                ..
            },
        ) if !username.is_empty() => issue
            .assignees
            .iter()
            .any(|assignee| normalized(assignee.username.as_deref()) == normalized(Some(username))),
        (
            Some(GitLabBoardListKind::Milestone),
            GitLabBoardList {
                milestone_title: Some(title),
                ..
            },
        ) if !title.is_empty() => {
            normalized(issue.milestone_title.as_deref()) == normalized(Some(title))
        }
        (
            Some(GitLabBoardListKind::Iteration),
            GitLabBoardList {
                iteration_title: Some(title),
                ..
            },
        ) if !title.is_empty() => {
            normalized(issue.iteration_title.as_deref()) == normalized(Some(title))
        }
        _ => false,
    }
}

fn is_closed(issue: &GitLabIssue) -> bool {
    issue.state.trim().eq_ignore_ascii_case("closed")
}

/// The issue's column, or `None` when the board hides the column it would land in.
fn resolve_issue_column(
    issue: &GitLabIssue,
    board: &GitLabBoard,
    lists: &[GitLabBoardList],
) -> Option<BoardColumn> {
    if is_closed(issue) {
        return (!board.hide_closed_list).then(|| closed_column(board));
    }
    if let Some(list) = lists.iter().find(|list| matches_board_list(issue, list)) {
        return Some(list_column(board, list));
    }
    (!board.hide_backlog_list).then(|| backlog_column(board))
}

fn to_issue_summary(
    issue: &GitLabIssue,
    project: &GitLabProject,
    status: &str,
    status_category: Option<String>,
) -> IssueSummary {
    let assignee = issue
        .assignees
        .iter()
        .filter_map(|assignee| assignee.name.clone().or_else(|| assignee.username.clone()))
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    IssueSummary {
        id: Some(issue.id.to_string()),
        key: issue_key_of(issue, project),
        summary: issue.title.clone(),
        status: status.to_string(),
        status_category,
        issue_type: "issue".to_string(),
        project_key: project.path_with_namespace.clone(),
        project_name: Some(project.name.clone()),
        parent_key: None,
        parent_issue: None,
        assignee: (!assignee.is_empty()).then_some(assignee),
        reporter: issue.author_name.clone(),
        reporter_mention: None,
        priority: None,
        severity: None,
        reported_by: None,
        complexity: None,
        model: None,
        created: issue.created_at.clone(),
        updated: issue.updated_at.clone(),
        self_url: None,
        browse_url: issue.web_url.clone(),
        description: issue.description.clone(),
        idea_transcript: None,
        planning_id: None,
        depends_on: None,
        branch: None,
        completed: None,
        attachments: None,
        ai_assignment: None,
        sub_tasks: None,
        child_seq: None,
        origin: None,
        source_path: None,
        raw: Some(issue.raw.clone()),
    }
}

/// `references.full`, else `<project path>#<iid>`.
fn issue_key_of(issue: &GitLabIssue, project: &GitLabProject) -> String {
    issue
        .references
        .as_ref()
        .and_then(|references| references.full.clone())
        .unwrap_or_else(|| format!("{}#{}", project.path_with_namespace, issue.iid))
}

fn to_issue_comments(comments: Vec<GitLabIssueComment>) -> Vec<IssueComment> {
    comments
        .into_iter()
        .map(|comment| IssueComment {
            id: Some(comment.id),
            author: comment.author,
            body: comment.body,
            created: comment.created_at,
            updated: comment.updated_at,
            raw: Some(comment.raw),
        })
        .collect()
}

fn build_board_transitions(
    issue: &GitLabIssue,
    context: &GitLabBoardContext,
) -> Vec<WorkflowTransition> {
    let current = resolve_issue_column(issue, &context.board, &context.lists).map(|c| c.name);
    build_board_columns(&context.board, &context.lists)
        .into_iter()
        .filter(|column| Some(&column.name) != current.as_ref())
        .map(|column| WorkflowTransition {
            id: format!("gitlab:{}", column.name),
            name: format!("Move to {}", column.name),
            to_status: Some(column.name.clone()),
            raw: serde_json::to_value(&column).ok(),
        })
        .collect()
}

/// The labels, assignees, milestone or iteration to change so the issue lands in the target
/// column — and leaves the board lists it no longer belongs to when it moves to Backlog.
fn build_gitlab_transition_update(
    issue: &GitLabIssue,
    target_column: &BoardColumn,
    target_list: Option<&GitLabBoardList>,
    context: &GitLabBoardContext,
) -> UpdateGitLabIssueInput {
    let mut update = UpdateGitLabIssueInput::default();
    let is_backlog_target = target_column.name == "Backlog";
    let target_kind = target_list.and_then(|list| list.kind);
    let board_has = |kind| context.lists.iter().any(|list| list.kind == Some(kind));

    if target_column.name == "Closed" {
        update.state_event = Some(GitLabStateEvent::Close);
    } else if is_closed(issue) {
        update.state_event = Some(GitLabStateEvent::Reopen);
    }

    apply_label_transition_update(&mut update, issue, target_list, is_backlog_target, context);

    if target_kind == Some(GitLabBoardListKind::Assignee) {
        update.assignee_ids = Some(
            target_list
                .and_then(|l| l.assignee_id)
                .into_iter()
                .collect(),
        );
    } else if is_backlog_target && board_has(GitLabBoardListKind::Assignee) {
        update.assignee_ids = Some(Vec::new());
    }

    if target_kind == Some(GitLabBoardListKind::Milestone) {
        update.milestone_id = Some(target_list.and_then(|l| l.milestone_id).unwrap_or(0));
    } else if is_backlog_target && board_has(GitLabBoardListKind::Milestone) {
        update.milestone_id = Some(0);
    }

    if target_kind == Some(GitLabBoardListKind::Iteration) {
        update.iteration_id = Some(target_list.and_then(|l| l.iteration_id).unwrap_or(0));
    } else if is_backlog_target && board_has(GitLabBoardListKind::Iteration) {
        update.iteration_id = Some(0);
    }

    update
}

fn apply_label_transition_update(
    update: &mut UpdateGitLabIssueInput,
    issue: &GitLabIssue,
    target_list: Option<&GitLabBoardList>,
    is_backlog_target: bool,
    context: &GitLabBoardContext,
) {
    let removable_board_labels: Vec<String> = context
        .lists
        .iter()
        .filter(|list| list.kind == Some(GitLabBoardListKind::Label))
        .filter_map(|list| list.label_name.clone())
        .filter(|label| !label.is_empty() && has_label(issue, label))
        .collect();

    let target_label = target_list
        .filter(|list| list.kind == Some(GitLabBoardListKind::Label))
        .and_then(|list| list.label_name.as_deref())
        .filter(|label| !label.is_empty());
    if let Some(target_label) = target_label {
        let target = normalized(Some(target_label));
        update.remove_labels = Some(
            removable_board_labels
                .into_iter()
                .filter(|label| normalized(Some(label)) != target)
                .collect(),
        );
        if !has_label(issue, target_label) {
            update.add_labels = Some(vec![target_label.to_string()]);
        }
        return;
    }

    if is_backlog_target && !removable_board_labels.is_empty() {
        update.remove_labels = Some(removable_board_labels);
    }
}

/// The user's distinct, non-empty normalized username and name.
fn normalized_user_labels(user: &GitLabUser) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    for value in [user.username.as_deref(), user.name.as_deref()] {
        let value = normalized(value);
        if !value.is_empty() && !labels.contains(&value) {
            labels.push(value);
        }
    }
    labels
}

/// The one user whose username or name is `search_text`; a username match breaks a tie.
fn pick_matching_gitlab_user<'a>(
    search_text: &str,
    users: &'a [GitLabUser],
) -> Option<&'a GitLabUser> {
    let search = normalized(Some(search_text));
    let exact: Vec<&GitLabUser> = users
        .iter()
        .filter(|user| normalized_user_labels(user).contains(&search))
        .collect();
    match exact.as_slice() {
        [only] => Some(only),
        [] => None,
        _ => {
            let by_username: Vec<&GitLabUser> = exact
                .into_iter()
                .filter(|user| normalized(user.username.as_deref()) == search)
                .collect();
            match by_username.as_slice() {
                [only] => Some(only),
                _ => None,
            }
        }
    }
}

fn build_board_issues(
    board: &GitLabBoard,
    lists: &[GitLabBoardList],
    issues: &[GitLabIssue],
) -> Vec<IssueSummary> {
    issues
        .iter()
        .filter_map(|issue| {
            let column = resolve_issue_column(issue, board, lists)?;
            Some(to_issue_summary(
                issue,
                &board.project,
                &column.name,
                column.status_category,
            ))
        })
        .collect()
}

/// The board-scoped issue filters a GitLab board carries.
fn board_issue_filters(board: &GitLabBoard) -> GitLabIssueListFilters {
    GitLabIssueListFilters {
        state: GitLabIssueStateFilter::All,
        labels: board.labels.clone(),
        assignee_username: board.assignee_username.clone(),
        milestone_title: board.milestone_title.clone(),
        iteration_title: None,
        weight: board.weight,
    }
}

/// A board known only by id, as `getIssues` addresses it.
fn board_with_id(id: &str) -> Board {
    Board {
        id: id.to_string(),
        name: String::new(),
        board_type: String::new(),
        created_by: None,
        created_at: None,
        project_key: None,
        project_name: None,
        location_name: None,
        connection_id: None,
        availability: None,
        availability_message: None,
        issue_creation: None,
        raw: None,
    }
}

fn dedupe_in_order(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for value in values {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    unique
}

fn retain_project_keys(
    projects: Vec<GitLabProject>,
    project_keys: &[String],
) -> Vec<GitLabProject> {
    if project_keys.is_empty() {
        return projects;
    }
    let selected: Vec<&str> = project_keys
        .iter()
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
        .collect();
    projects
        .into_iter()
        .filter(|project| selected.contains(&project.path_with_namespace.as_str()))
        .collect()
}

#[derive(Debug, Default)]
struct GitLabCache {
    api_config: Option<GitLabApiConfig>,
    board_context_by_issue_key: HashMap<String, GitLabBoardContext>,
}

/// The `gitlab` backend: one instance, its configured project(s) and their boards.
pub struct GitLabBoardService {
    config_store: Arc<dyn GitLabConfigStore>,
    output: Arc<dyn LogSink>,
    client: Client,
    options: GitLabBoardServiceOptions,
    cache: Mutex<GitLabCache>,
}

impl GitLabBoardService {
    #[must_use]
    pub fn new(config_store: Arc<dyn GitLabConfigStore>, output: Arc<dyn LogSink>) -> Self {
        Self::with_options(
            config_store,
            output,
            Client::new(),
            GitLabBoardServiceOptions::default(),
        )
    }

    #[must_use]
    pub fn with_options(
        config_store: Arc<dyn GitLabConfigStore>,
        output: Arc<dyn LogSink>,
        client: Client,
        options: GitLabBoardServiceOptions,
    ) -> Self {
        Self {
            config_store,
            output,
            client,
            options,
            cache: Mutex::new(GitLabCache::default()),
        }
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, GitLabCache> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn board_context(&self, issue_key: &str) -> Option<GitLabBoardContext> {
        self.cache()
            .board_context_by_issue_key
            .get(issue_key)
            .cloned()
    }

    fn remember_board_context(&self, issues: &[IssueSummary], context: &GitLabBoardContext) {
        let mut cache = self.cache();
        for issue in issues {
            cache
                .board_context_by_issue_key
                .insert(issue.key.clone(), context.clone());
        }
    }

    fn configured_base_url(&self) -> String {
        self.config_store
            .get_gitlab_url()
            .trim()
            .trim_end_matches('/')
            .to_string()
    }

    fn selected_board_refs(&self) -> Vec<GitLabSelectedBoardRef> {
        self.config_store
            .get_gitlab_selected_board_refs()
            .iter()
            .filter_map(|value| parse_gitlab_selected_board_ref(value))
            .collect()
    }

    fn lists_all_accessible_boards(&self) -> bool {
        self.config_store.get_gitlab_list_all_accessible_boards()
    }

    async fn api_config(&self) -> TrackerResult<GitLabApiConfig> {
        if let Some(config) = self.cache().api_config.clone() {
            return Ok(config);
        }
        let token = resolve_api_token(
            self.options.secrets.as_ref(),
            || self.config_store.get_gitlab_api_key(),
            self.options.environment_token,
        )
        .await?;
        if token.is_empty() {
            return Err("No GitLab API key is configured.".to_string());
        }

        let configured = self
            .config_store
            .get_gitlab_project_path()
            .trim()
            .to_string();
        let mut project_path = if configured.is_empty() {
            self.selected_board_refs()
                .into_iter()
                .next()
                .map(|selected| selected.project_path)
                .unwrap_or_default()
        } else {
            configured
        };
        if project_path.is_empty() && !self.lists_all_accessible_boards() {
            let workspace = self
                .options
                .workspace_folder_path
                .as_ref()
                .and_then(|lookup| lookup())
                .ok_or_else(|| {
                    "Configure a GitLab project path, or open the repository workspace so the project can be inferred."
                        .to_string()
                })?;
            project_path = self
                .options
                .project_inference
                .infer(&workspace)
                .await?
                .project_path;
        }

        let config = GitLabApiConfig {
            base_url: self.configured_base_url(),
            project_path,
            token,
        };
        self.cache().api_config = Some(config.clone());
        self.output.append_line(&if config.project_path.is_empty() {
            "[gitlab] Listing boards across accessible GitLab projects.".to_string()
        } else {
            format!(
                "[gitlab] Using GitLab boards project {}.",
                config.project_path
            )
        });
        Ok(config)
    }

    async fn api_client(&self) -> TrackerResult<GitLabApiService> {
        Ok(GitLabApiService::with_client(
            self.api_config().await?,
            self.client.clone(),
        ))
    }

    async fn resolve_projects(
        &self,
        client: &GitLabApiService,
        project_keys: &[String],
    ) -> TrackerResult<Vec<GitLabProject>> {
        let configured = self.config_store.get_gitlab_project_path();
        let configured = configured.trim();
        let list_all = self.lists_all_accessible_boards();
        let selected = self.selected_board_refs();
        if !configured.is_empty() && !list_all {
            return Ok(vec![client.get_project(None).await?]);
        }
        if !selected.is_empty() && !list_all {
            let mut projects = Vec::new();
            for path in dedupe_in_order(selected.into_iter().map(|s| s.project_path)) {
                let project_ref = GitLabProjectRef::Path(path);
                projects.push(client.get_project(Some(&project_ref)).await?);
            }
            return Ok(retain_project_keys(projects, project_keys));
        }
        if configured.is_empty() && !list_all {
            return Ok(vec![client.get_project(None).await?]);
        }
        let projects = client.list_accessible_projects(None).await?;
        Ok(retain_project_keys(projects, project_keys))
    }

    async fn list_boards_for_projects(
        client: &GitLabApiService,
        projects: &[GitLabProject],
    ) -> TrackerResult<Vec<GitLabBoard>> {
        let mut boards = Vec::new();
        for project in projects {
            boards.extend(
                client
                    .list_boards(Some(&GitLabProjectRef::Id(project.id)))
                    .await?,
            );
        }
        Ok(boards)
    }

    async fn list_visible_boards(
        &self,
        client: &GitLabApiService,
        project_keys: &[String],
    ) -> TrackerResult<Vec<GitLabBoard>> {
        let selected = self.selected_board_refs();
        if !selected.is_empty() && !self.lists_all_accessible_boards() {
            let mut boards = Vec::new();
            for selected in selected.into_iter().filter(|selected| {
                project_keys.is_empty() || project_keys.contains(&selected.project_path)
            }) {
                let project_ref = GitLabProjectRef::Path(selected.project_path);
                boards.push(
                    client
                        .get_board(selected.board_id, Some(&project_ref))
                        .await?,
                );
            }
            return Ok(boards);
        }
        let projects = self.resolve_projects(client, project_keys).await?;
        Self::list_boards_for_projects(client, &projects).await
    }

    fn parse_board_reference(&self, board: &Board) -> TrackerResult<(GitLabProjectRef, u64)> {
        static WITH_OPTIONAL_PROJECT: OnceLock<Regex> = OnceLock::new();
        static PROJECT_AND_BOARD: OnceLock<Regex> = OnceLock::new();
        static LEGACY: OnceLock<Regex> = OnceLock::new();
        let with_optional_project = WITH_OPTIONAL_PROJECT.get_or_init(|| {
            Regex::new(r"^gitlab:(?:\d+:)?(\d+)$").expect("the board id pattern is valid")
        });
        let project_and_board = PROJECT_AND_BOARD.get_or_init(|| {
            Regex::new(r"^gitlab:(\d+):(\d+)$").expect("the board id pattern is valid")
        });
        let legacy = LEGACY
            .get_or_init(|| Regex::new(r"^gitlab:(\d+)$").expect("the board id pattern is valid"));
        let board_id = board.id.trim();
        let invalid = || format!("Invalid GitLab board identifier: {}", board.id);
        let raw = board.raw.as_ref();
        let raw_id = raw.and_then(|raw| raw.get("id")).and_then(Value::as_u64);

        let project_key = board
            .project_key
            .as_deref()
            .map(str::trim)
            .unwrap_or_default();
        if !project_key.is_empty() {
            let parsed = raw_id.or_else(|| {
                with_optional_project
                    .captures(board_id)
                    .and_then(|captures| captures[1].parse().ok())
            });
            if let Some(parsed) = parsed {
                return Ok((GitLabProjectRef::Path(project_key.to_string()), parsed));
            }
        }

        let raw_project_id = raw
            .and_then(|raw| raw.get("project"))
            .and_then(|project| project.get("id"))
            .and_then(Value::as_u64);
        if let (Some(project_id), Some(id)) = (raw_project_id, raw_id) {
            return Ok((GitLabProjectRef::Id(project_id), id));
        }

        if let Some(captures) = project_and_board.captures(board_id) {
            let project_id = captures[1].parse().map_err(|_| invalid())?;
            let id = captures[2].parse().map_err(|_| invalid())?;
            return Ok((GitLabProjectRef::Id(project_id), id));
        }

        if let Some(captures) = legacy.captures(board_id) {
            let configured = self.config_store.get_gitlab_project_path();
            let configured = configured.trim();
            if configured.is_empty() {
                return Err(invalid());
            }
            let id = captures[1].parse().map_err(|_| invalid())?;
            return Ok((GitLabProjectRef::Path(configured.to_string()), id));
        }

        Err(invalid())
    }

    /// The board, its lists and its issues; every issue's board context is remembered.
    async fn load_board(
        &self,
        board: &Board,
    ) -> TrackerResult<(GitLabBoardContext, Vec<IssueSummary>)> {
        let (project_ref, board_id) = self.parse_board_reference(board)?;
        let client = self.api_client().await?;
        let (gitlab_board, lists) = tokio::try_join!(
            client.get_board(board_id, Some(&project_ref)),
            client.list_board_lists(board_id, Some(&project_ref))
        )?;
        let issues = client
            .list_issues(Some(&project_ref), &board_issue_filters(&gitlab_board))
            .await?;
        let board_issues = build_board_issues(&gitlab_board, &lists, &issues);
        let context = GitLabBoardContext {
            board: gitlab_board,
            lists,
        };
        self.remember_board_context(&board_issues, &context);
        Ok((context, board_issues))
    }

    async fn resolve_assignee_ids(
        client: &GitLabApiService,
        assignee: Option<&str>,
    ) -> TrackerResult<Vec<u64>> {
        let requested: Vec<&str> = assignee
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect();
        let mut ids = Vec::new();
        for requested_assignee in requested {
            let users = client.find_users(requested_assignee).await?;
            match pick_matching_gitlab_user(requested_assignee, &users) {
                Some(user) if user.id != 0 => ids.push(user.id),
                _ => {
                    return Err(format!(
                        "Could not resolve GitLab assignee \"{requested_assignee}\" to a unique user."
                    ));
                }
            }
        }
        Ok(ids)
    }
}

#[async_trait]
impl IssueTrackerService for GitLabBoardService {
    fn mode(&self) -> BackendMode {
        BackendMode::Gitlab
    }

    fn get_default_page_size(&self) -> usize {
        self.config_store.get_default_page_size()
    }

    async fn reset(&self) -> TrackerResult<()> {
        *self.cache() = GitLabCache::default();
        Ok(())
    }

    async fn check_connection(&self) -> TrackerResult<ConnectionCheck> {
        let client = self.api_client().await?;
        let projects = self.resolve_projects(&client, &[]).await?;
        let boards = Self::list_boards_for_projects(&client, &projects).await?;
        let server_name = Some(self.configured_base_url());
        if let [project] = projects.as_slice() {
            let message = if boards.is_empty() {
                format!(
                    "Connected to GitLab project {}, but no boards are available.",
                    project.path_with_namespace
                )
            } else {
                format!(
                    "Connected to GitLab project {}. {} board(s) found.",
                    project.path_with_namespace,
                    boards.len()
                )
            };
            return Ok(ConnectionCheck {
                status: ConnectionCheckStatus::Ok,
                message,
                tool_count: 3,
                project_count: Some(1),
                server_name,
            });
        }
        let message = if boards.is_empty() {
            format!(
                "Connected to GitLab. {} accessible project(s) found, but no boards are available.",
                projects.len()
            )
        } else {
            format!(
                "Connected to GitLab. {} board(s) found across {} accessible project(s).",
                boards.len(),
                projects.len()
            )
        };
        Ok(ConnectionCheck {
            status: ConnectionCheckStatus::Ok,
            message,
            tool_count: 3,
            project_count: Some(u32::try_from(projects.len()).unwrap_or(u32::MAX)),
            server_name,
        })
    }

    async fn get_projects(&self, _force_refresh: bool) -> TrackerResult<Vec<Project>> {
        let client = self.api_client().await?;
        Ok(self
            .resolve_projects(&client, &[])
            .await?
            .into_iter()
            .map(|project| Project {
                id: Some(project.id.to_string()),
                key: project.path_with_namespace,
                name: project.name,
            })
            .collect())
    }

    /// GitLab's list API has no notion of our status/type/parent filters, so the board's
    /// full issue set is fetched (the same calls as `get_board_details`) and filtered and
    /// paged in memory. Requires `filters.board_id` — without a board there are no lists to
    /// resolve statuses against.
    async fn get_issues(
        &self,
        filters: &IssueFilters,
        start_at: usize,
        page_size: usize,
    ) -> TrackerResult<PagedIssues> {
        let Some(board_id) = filters.board_id.as_deref().filter(|id| !id.is_empty()) else {
            return Ok(PagedIssues {
                issues: Vec::new(),
                total: Some(0),
                has_more: false,
            });
        };
        let (_, board_issues) = self.load_board(&board_with_id(board_id)).await?;
        let parent_key = filters.parent_key.as_deref().filter(|key| !key.is_empty());
        let matching = board_issues
            .into_iter()
            .filter(|issue| parent_key.is_none_or(|key| issue.parent_key.as_deref() == Some(key)))
            .filter(|issue| matches_issue_filters(issue, filters))
            .collect();
        Ok(page_sorted_issues(matching, start_at, page_size))
    }

    async fn get_filter_metadata(&self, filters: &IssueFilters) -> TrackerResult<FilterMetadata> {
        let metadata_filters = IssueFilters {
            statuses: Vec::new(),
            issue_types: Vec::new(),
            ..filters.clone()
        };
        let page = self.get_issues(&metadata_filters, 0, usize::MAX).await?;
        Ok(filter_metadata_of(&page.issues))
    }

    async fn get_parent_items(
        &self,
        _filters: &IssueFilters,
        _search_text: Option<&str>,
        _options: Option<&ParentItemQueryOptions>,
    ) -> TrackerResult<Vec<IssueSummary>> {
        Ok(Vec::new())
    }

    async fn supports_boards(&self) -> TrackerResult<bool> {
        Ok(true)
    }

    async fn get_boards(&self, filters: &BoardFilters) -> TrackerResult<Vec<Board>> {
        let client = self.api_client().await?;
        let boards = self
            .list_visible_boards(&client, &filters.project_keys)
            .await?;
        Ok(boards
            .into_iter()
            .map(|board| Board {
                id: format!("gitlab:{}:{}", board.project.id, board.id),
                name: board.name.clone(),
                board_type: "issue-board".to_string(),
                created_by: board.created_by.clone(),
                created_at: board.created_at.clone(),
                project_key: Some(board.project.path_with_namespace.clone()),
                project_name: Some(board.project.name.clone()),
                location_name: Some(self.configured_base_url()),
                connection_id: None,
                availability: None,
                availability_message: None,
                issue_creation: None,
                raw: serde_json::to_value(&board).ok(),
            })
            .filter(|board| matches_board_filters(board, filters))
            .collect())
    }

    async fn get_board_details(&self, board: &Board) -> TrackerResult<BoardDetails> {
        let (context, issues) = self.load_board(board).await?;
        let columns = build_board_columns(&context.board, &context.lists);
        let mut issues_by_status: HashMap<&str, Vec<IssueSummary>> = HashMap::new();
        for issue in &issues {
            issues_by_status
                .entry(issue.status.as_str())
                .or_default()
                .push(issue.clone());
        }
        let column_status_order = columns.iter().map(|column| column.name.clone()).collect();
        let columns = columns
            .into_iter()
            .map(|column| BoardColumn {
                issues: issues_by_status
                    .get(column.name.as_str())
                    .cloned()
                    .unwrap_or_default(),
                ..column
            })
            .collect();
        let gitlab_board = &context.board;
        Ok(BoardDetails {
            board: Board {
                name: gitlab_board.name.clone(),
                project_key: Some(gitlab_board.project.path_with_namespace.clone()),
                project_name: Some(gitlab_board.project.name.clone()),
                location_name: Some(self.configured_base_url()),
                raw: serde_json::to_value(gitlab_board).ok(),
                ..board.clone()
            },
            columns,
            issues,
            column_status_order: Some(column_status_order),
        })
    }

    async fn create_board(&self, _input: &CreateBoardInput) -> TrackerResult<Board> {
        Err("GitLab mode does not support creating boards. Create the board in GitLab, then select it on the connection.".to_string())
    }

    async fn update_board(
        &self,
        _board_id: &str,
        _input: &UpdateBoardInput,
    ) -> TrackerResult<Board> {
        Err("GitLab mode does not support updating boards. Edit the board in GitLab; Praxis reads it live.".to_string())
    }

    async fn delete_board(&self, _board_id: &str) -> TrackerResult<()> {
        Err("GitLab mode does not support deleting boards. Delete the board in GitLab, or deselect it on the connection.".to_string())
    }

    async fn get_issue(&self, issue_key: &str) -> TrackerResult<IssueDetails> {
        let (project_path, issue_iid) = parse_gitlab_issue_key(issue_key)?;
        let project_ref = GitLabProjectRef::Path(project_path);
        let client = self.api_client().await?;
        let (issue, comments) = tokio::try_join!(
            client.get_issue(issue_iid, Some(&project_ref)),
            client.list_issue_comments(issue_iid, Some(&project_ref))
        )?;
        let project = client.get_project(Some(&project_ref)).await?;
        let context = self.board_context(issue_key);
        let column = context
            .as_ref()
            .and_then(|context| resolve_issue_column(&issue, &context.board, &context.lists));
        let closed = is_closed(&issue);
        let (status, status_category) = match column {
            Some(column) => (column.name, column.status_category),
            None if closed => ("Closed".to_string(), Some("done".to_string())),
            None => ("Open".to_string(), None),
        };
        Ok(IssueDetails {
            summary: to_issue_summary(&issue, &project, &status, status_category),
            transitions: Some(
                context
                    .map(|context| build_board_transitions(&issue, &context))
                    .unwrap_or_default(),
            ),
            comments: Some(to_issue_comments(comments)),
            linked_issues: None,
        })
    }

    async fn create_issue(&self, input: &CreateIssueInput) -> TrackerResult<IssueDetails> {
        if !self.config_store.get_gitlab_allow_issue_creation() {
            return Err(ISSUE_CREATION_DISABLED_ERROR.to_string());
        }
        let summary = input.summary.trim();
        if summary.is_empty() {
            return Err("Summary cannot be empty.".to_string());
        }
        let client = self.api_client().await?;
        let project_key = input.project_key.trim();
        let project_ref =
            (!project_key.is_empty()).then(|| GitLabProjectRef::Path(project_key.to_string()));
        let project = client.get_project(project_ref.as_ref()).await?;
        let created = client
            .create_issue(
                &CreateGitLabIssueInput {
                    title: summary.to_string(),
                    description: input
                        .description
                        .as_deref()
                        .map(str::trim)
                        .filter(|description| !description.is_empty())
                        .map(str::to_string),
                    ..CreateGitLabIssueInput::default()
                },
                project_ref.as_ref(),
            )
            .await?;
        self.get_issue(&issue_key_of(&created, &project)).await
    }

    async fn update_issue(
        &self,
        issue_key: &str,
        input: &UpdateIssueInput,
    ) -> TrackerResult<IssueDetails> {
        let unsupported = unsupported_issue_edit_fields(input);
        if !unsupported.is_empty() {
            return Err(format!(
                "GitLab issue editing currently supports summary, description, and assignee only. Unsupported fields: {}.",
                unsupported.join(", ")
            ));
        }
        let (project_path, issue_iid) = parse_gitlab_issue_key(issue_key)?;
        let project_ref = GitLabProjectRef::Path(project_path);
        let client = self.api_client().await?;
        let assignee_ids = match &input.assignee {
            Some(assignee) => Some(Self::resolve_assignee_ids(&client, assignee.as_deref()).await?),
            None => None,
        };
        client
            .update_issue(
                issue_iid,
                &UpdateGitLabIssueInput {
                    title: input.summary.as_deref().map(|s| s.trim().to_string()),
                    description: input.description.clone(),
                    assignee_ids,
                    ..UpdateGitLabIssueInput::default()
                },
                Some(&project_ref),
            )
            .await?;
        self.get_issue(issue_key).await
    }

    async fn delete_issue(&self, _issue_key: &str) -> TrackerResult<()> {
        Err("GitLab mode does not support deleting issues. Close the issue instead.".to_string())
    }

    async fn add_comment(&self, issue_key: &str, body: &str) -> TrackerResult<()> {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Err("Comment cannot be empty.".to_string());
        }
        let (project_path, issue_iid) = parse_gitlab_issue_key(issue_key)?;
        let client = self.api_client().await?;
        client
            .add_issue_comment(
                issue_iid,
                trimmed,
                Some(&GitLabProjectRef::Path(project_path)),
            )
            .await?;
        Ok(())
    }

    async fn attach_file(
        &self,
        _issue_key: &str,
        _file_path: &str,
        _file_name: Option<&str>,
    ) -> TrackerResult<()> {
        Err(ATTACHMENTS_UNSUPPORTED.to_string())
    }

    async fn download_attachment(
        &self,
        _issue_key: &str,
        _attachment: &IssueAttachment,
        _target_file_path: &str,
    ) -> TrackerResult<()> {
        Err(ATTACHMENTS_UNSUPPORTED.to_string())
    }

    async fn get_transitions(&self, issue_key: &str) -> TrackerResult<Vec<WorkflowTransition>> {
        let Some(context) = self.board_context(issue_key) else {
            return Ok(Vec::new());
        };
        let (project_path, issue_iid) = parse_gitlab_issue_key(issue_key)?;
        let client = self.api_client().await?;
        let issue = client
            .get_issue(issue_iid, Some(&GitLabProjectRef::Path(project_path)))
            .await?;
        Ok(build_board_transitions(&issue, &context))
    }

    async fn transition_issue(&self, issue_key: &str, transition_id: &str) -> TrackerResult<()> {
        let context = self.board_context(issue_key).ok_or_else(|| {
            "Load the GitLab board before moving cards so board column transitions are available."
                .to_string()
        })?;
        let target_status = transition_id
            .strip_prefix("gitlab:")
            .unwrap_or(transition_id)
            .trim();
        let (project_path, issue_iid) = parse_gitlab_issue_key(issue_key)?;
        let project_ref = GitLabProjectRef::Path(project_path);
        let client = self.api_client().await?;
        let issue = client.get_issue(issue_iid, Some(&project_ref)).await?;
        let target_column = build_board_columns(&context.board, &context.lists)
            .into_iter()
            .find(|column| column.name == target_status)
            .ok_or_else(|| format!("Unknown GitLab board column: {target_status}"))?;
        let target_list = context
            .lists
            .iter()
            .find(|list| list.title == target_column.name);
        let update = build_gitlab_transition_update(&issue, &target_column, target_list, &context);
        client
            .update_issue(issue_iid, &update, Some(&project_ref))
            .await?;
        Ok(())
    }

    async fn get_browse_url(&self, issue: &IssueSummary) -> TrackerResult<Option<String>> {
        Ok(issue.browse_url.clone())
    }

    async fn get_self_assignee_label(&self) -> TrackerResult<Option<String>> {
        let client = self.api_client().await?;
        let user = client.get_current_user().await?;
        let pick = |value: Option<&str>| {
            value
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        Ok(pick(user.username.as_deref()).or_else(|| pick(user.name.as_deref())))
    }
}

#[cfg(test)]
mod tests;
