//! GitHub issues as a Praxis board (`github/githubBoardService.ts` port).
//!
//! Boards are synthesized from status labels named `status: <value>` already on the
//! repository — the same "works with zero setup" model as folder: a repo with no such labels
//! still renders a two-column board (Backlog / Closed), and every `status: X` label found
//! becomes its own column, sorted by its value. There is deliberately no manual reordering
//! or renaming.
//!
//! The repository's API config and status labels are cached until [`reset`]; the cache sits
//! behind a `std::sync::Mutex` that is never held across an await.
//!
//! [`reset`]: IssueTrackerService::reset

use std::collections::{BTreeSet, HashMap};
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

use crate::github::api_service::{
    CreateGitHubIssueInput, DEFAULT_GITHUB_API_URL, GitHubApiConfig, GitHubApiService, GitHubIssue,
    GitHubIssueComment, GitHubIssueState, UpdateGitHubIssueInput,
};
use crate::github::config_store::{GitHubBoardServiceOptions, GitHubConfigStore};
use crate::issue_tracker_service::{IssueTrackerService, LogSink, TrackerResult};

const ISSUE_CREATION_DISABLED_ERROR: &str = "Issue creation is disabled for this repository. Enable it on the connection to create GitHub issues.";
const ATTACHMENTS_UNSUPPORTED: &str = "GitHub mode does not support attachments. Add files as links in the issue description or a comment instead.";

/// The `<value>` of a `status: <value>` label, case-insensitively.
#[must_use]
pub fn extract_status_label_value(label: &str) -> Option<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"(?i)^status:\s*(.+)$").expect("the status label pattern is valid")
    });
    pattern
        .captures(label.trim())
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_string())
}

/// The issue number from an `owner/repo#123` key.
pub fn parse_github_issue_key(issue_key: &str) -> TrackerResult<u64> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern =
        PATTERN.get_or_init(|| Regex::new(r"#([0-9]+)$").expect("the issue key pattern is valid"));
    pattern
        .captures(issue_key.trim())
        .and_then(|captures| captures.get(1))
        .and_then(|number| number.as_str().parse().ok())
        .ok_or_else(|| format!("Invalid GitHub issue key: {issue_key}"))
}

/// `localeCompare` approximated as case-insensitive first, then lowercase before uppercase
/// on a case-only tie, as ICU orders them.
fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| right.cmp(left))
}

/// Most recently updated first, then by key (`board/boardColumns.ts`'s `sortIssuesByUpdated`).
fn sort_issues_by_updated(issues: &mut [IssueSummary]) {
    issues.sort_by(|left, right| {
        locale_compare(
            right.updated.as_deref().unwrap_or_default(),
            left.updated.as_deref().unwrap_or_default(),
        )
        .then_with(|| locale_compare(&left.key, &right.key))
    });
}

fn column(id: &str, name: &str, status_category: Option<&str>) -> BoardColumn {
    BoardColumn {
        id: id.to_string(),
        name: name.to_string(),
        status_category: status_category.map(str::to_string),
        issues: Vec::new(),
    }
}

fn backlog_column() -> BoardColumn {
    column("backlog", "Backlog", Some("todo"))
}

fn closed_column() -> BoardColumn {
    column("closed", "Closed", Some("done"))
}

fn status_column(label: &str) -> BoardColumn {
    column(&format!("status:{label}"), label, None)
}

fn build_board_columns(status_labels: &[String]) -> Vec<BoardColumn> {
    let mut columns = vec![backlog_column()];
    columns.extend(status_labels.iter().map(|label| status_column(label)));
    columns.push(closed_column());
    columns
}

fn resolve_issue_column(issue: &GitHubIssue, status_labels: &[String]) -> BoardColumn {
    if issue.state.trim().eq_ignore_ascii_case("closed") {
        return closed_column();
    }
    let issue_status_values: Vec<String> = issue
        .labels
        .iter()
        .filter_map(|label| extract_status_label_value(label))
        .collect();
    status_labels
        .iter()
        .find(|label| {
            issue_status_values
                .iter()
                .any(|value| value.to_lowercase() == label.to_lowercase())
        })
        .map_or_else(backlog_column, |label| status_column(label))
}

fn non_status_labels(issue: &GitHubIssue) -> Vec<String> {
    issue
        .labels
        .iter()
        .filter(|label| extract_status_label_value(label).is_none())
        .cloned()
        .collect()
}

fn to_issue_summary(
    issue: &GitHubIssue,
    config: &GitHubApiConfig,
    column: &BoardColumn,
) -> IssueSummary {
    let project_key = format!("{}/{}", config.owner, config.repo);
    let assignee = issue
        .assignees
        .iter()
        .map(|assignee| {
            assignee
                .name
                .clone()
                .unwrap_or_else(|| assignee.login.clone())
        })
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    IssueSummary {
        id: Some(issue.id.to_string()),
        key: format!("{project_key}#{}", issue.number),
        summary: issue.title.clone(),
        status: column.name.clone(),
        status_category: column.status_category.clone(),
        issue_type: "issue".to_string(),
        project_key,
        project_name: Some(config.repo.clone()),
        parent_key: None,
        parent_issue: None,
        assignee: (!assignee.is_empty()).then_some(assignee),
        reporter: issue.author_login.clone(),
        reporter_mention: None,
        priority: None,
        severity: None,
        reported_by: None,
        complexity: None,
        model: None,
        created: issue.created_at.clone(),
        updated: issue.updated_at.clone(),
        self_url: None,
        browse_url: issue.html_url.clone(),
        description: issue.body.clone(),
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

fn to_issue_comments(comments: Vec<GitHubIssueComment>) -> Vec<IssueComment> {
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

fn build_board_issues(
    issues: &[GitHubIssue],
    config: &GitHubApiConfig,
    status_labels: &[String],
) -> Vec<IssueSummary> {
    issues
        .iter()
        .map(|issue| to_issue_summary(issue, config, &resolve_issue_column(issue, status_labels)))
        .collect()
}

fn build_board_transitions(
    issue: &GitHubIssue,
    status_labels: &[String],
) -> Vec<WorkflowTransition> {
    let current = resolve_issue_column(issue, status_labels);
    build_board_columns(status_labels)
        .into_iter()
        .filter(|column| column.id != current.id)
        .map(|column| WorkflowTransition {
            id: format!("github:{}", column.id),
            name: format!("Move to {}", column.name),
            to_status: Some(column.name.clone()),
            raw: serde_json::to_value(&column).ok(),
        })
        .collect()
}

fn unsupported_issue_edit_fields(input: &UpdateIssueInput) -> Vec<&'static str> {
    let mut unsupported = Vec::new();
    if input.parent_key.is_some() {
        unsupported.push("parentKey");
    }
    if input.priority.is_some() {
        unsupported.push("priority");
    }
    if input.severity.is_some() {
        unsupported.push("severity");
    }
    if input.reported_by.is_some() {
        unsupported.push("reportedBy");
    }
    if input.model.is_some() {
        unsupported.push("model");
    }
    if input.issue_type.is_some() {
        unsupported.push("issueType");
    }
    if input.idea_transcript.is_some() {
        unsupported.push("ideaTranscript");
    }
    unsupported
}

fn parse_assignee_logins(assignee: Option<&str>) -> Vec<String> {
    assignee
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|login| !login.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn matches_board_filters(board: &Board, filters: &BoardFilters) -> bool {
    if !filters.types.is_empty() && !filters.types.contains(&board.board_type) {
        return false;
    }
    if !filters.project_keys.is_empty() {
        let board_project_key = board
            .project_key
            .as_deref()
            .map(str::trim)
            .unwrap_or_default();
        if board_project_key.is_empty()
            || !filters
                .project_keys
                .iter()
                .any(|key| key == board_project_key)
        {
            return false;
        }
    }
    let search_text = filters.search_text.trim().to_lowercase();
    if search_text.is_empty() {
        return true;
    }
    format!(
        "{} {} {} {}",
        board.name,
        board.project_key.as_deref().unwrap_or_default(),
        board.project_name.as_deref().unwrap_or_default(),
        board.location_name.as_deref().unwrap_or_default()
    )
    .to_lowercase()
    .contains(&search_text)
}

#[derive(Debug, Default)]
struct GitHubCache {
    api_config: Option<GitHubApiConfig>,
    status_labels: Option<Vec<String>>,
}

/// The `github` backend: one repository, one synthesized board.
pub struct GitHubBoardService {
    config_store: Arc<dyn GitHubConfigStore>,
    output: Arc<dyn LogSink>,
    client: Client,
    options: GitHubBoardServiceOptions,
    cache: Mutex<GitHubCache>,
}

impl GitHubBoardService {
    #[must_use]
    pub fn new(config_store: Arc<dyn GitHubConfigStore>, output: Arc<dyn LogSink>) -> Self {
        Self::with_options(
            config_store,
            output,
            Client::new(),
            GitHubBoardServiceOptions::default(),
        )
    }

    #[must_use]
    pub fn with_options(
        config_store: Arc<dyn GitHubConfigStore>,
        output: Arc<dyn LogSink>,
        client: Client,
        options: GitHubBoardServiceOptions,
    ) -> Self {
        Self {
            config_store,
            output,
            client,
            options,
            cache: Mutex::new(GitHubCache::default()),
        }
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, GitHubCache> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn configured_base_url(&self) -> String {
        let configured = self.config_store.get_github_api_url();
        let trimmed = configured.trim();
        let base = if trimmed.is_empty() {
            DEFAULT_GITHUB_API_URL
        } else {
            trimmed
        };
        base.trim_end_matches('/').to_string()
    }

    async fn resolve_token(&self) -> TrackerResult<String> {
        let primary = match &self.options.secrets {
            Some(secrets) => secrets.get_api_key().await?,
            None => self.config_store.get_github_api_key(),
        };
        let primary = primary.trim();
        if !primary.is_empty() {
            return Ok(primary.to_string());
        }
        Ok((self.options.environment_token)()
            .map(|token| token.trim().to_string())
            .unwrap_or_default())
    }

    async fn api_config(&self) -> TrackerResult<GitHubApiConfig> {
        if let Some(config) = self.cache().api_config.clone() {
            return Ok(config);
        }
        let token = self.resolve_token().await?;
        if token.is_empty() {
            return Err("No GitHub personal access token is configured.".to_string());
        }
        let owner = self.config_store.get_github_owner().trim().to_string();
        let repo = self.config_store.get_github_repo().trim().to_string();
        if owner.is_empty() || repo.is_empty() {
            return Err(
                "Configure a GitHub repository owner and name for this connection.".to_string(),
            );
        }
        let config = GitHubApiConfig {
            base_url: self.configured_base_url(),
            owner,
            repo,
            token,
        };
        self.cache().api_config = Some(config.clone());
        self.output.append_line(&format!(
            "[github] Using GitHub repository {}/{}.",
            config.owner, config.repo
        ));
        Ok(config)
    }

    async fn api_client(&self) -> TrackerResult<GitHubApiService> {
        Ok(GitHubApiService::with_client(
            self.api_config().await?,
            self.client.clone(),
        ))
    }

    async fn ensure_status_labels(&self, client: &GitHubApiService) -> TrackerResult<Vec<String>> {
        if let Some(labels) = self.cache().status_labels.clone() {
            return Ok(labels);
        }
        let labels = client.list_labels().await?;
        let unique: BTreeSet<String> = labels
            .iter()
            .filter_map(|label| extract_status_label_value(&label.name))
            .collect();
        let mut values: Vec<String> = unique.into_iter().collect();
        values.sort_by(|left, right| locale_compare(left, right));
        self.cache().status_labels = Some(values.clone());
        Ok(values)
    }

    async fn issues_and_status_labels(
        &self,
        client: &GitHubApiService,
    ) -> TrackerResult<(Vec<GitHubIssue>, Vec<String>)> {
        tokio::try_join!(
            async { client.list_issues().await.map_err(String::from) },
            self.ensure_status_labels(client)
        )
    }

    async fn issue_and_status_labels(
        &self,
        client: &GitHubApiService,
        issue_number: u64,
    ) -> TrackerResult<(GitHubIssue, Vec<String>)> {
        tokio::try_join!(
            async { client.get_issue(issue_number).await.map_err(String::from) },
            self.ensure_status_labels(client)
        )
    }
}

#[async_trait]
impl IssueTrackerService for GitHubBoardService {
    fn mode(&self) -> BackendMode {
        BackendMode::Github
    }

    fn get_default_page_size(&self) -> usize {
        self.config_store.get_default_page_size()
    }

    async fn reset(&self) -> TrackerResult<()> {
        *self.cache() = GitHubCache::default();
        Ok(())
    }

    async fn check_connection(&self) -> TrackerResult<ConnectionCheck> {
        let client = self.api_client().await?;
        let repo = client.get_repo().await?;
        let status_labels = self.ensure_status_labels(&client).await?;
        let message = if status_labels.is_empty() {
            format!(
                "Connected to GitHub repository {}. No \"status: …\" labels found — the board shows Backlog and Closed only.",
                repo.full_name
            )
        } else {
            format!(
                "Connected to GitHub repository {}. {} status column(s) found: {}.",
                repo.full_name,
                status_labels.len(),
                status_labels.join(", ")
            )
        };
        Ok(ConnectionCheck {
            status: ConnectionCheckStatus::Ok,
            message,
            tool_count: 2,
            project_count: Some(1),
            server_name: Some(self.configured_base_url()),
        })
    }

    async fn get_projects(&self, _force_refresh: bool) -> TrackerResult<Vec<Project>> {
        let config = self.api_config().await?;
        let key = format!("{}/{}", config.owner, config.repo);
        Ok(vec![Project {
            id: None,
            key: key.clone(),
            name: key,
        }])
    }

    /// GitHub's REST API has no notion of our status/type/parent filters, so the
    /// repository's full issue set is fetched once and filtered and paged in memory.
    /// Requires `filters.board_id`: there is one board per connection, so this only guards
    /// against an unloaded board.
    async fn get_issues(
        &self,
        filters: &IssueFilters,
        start_at: usize,
        page_size: usize,
    ) -> TrackerResult<PagedIssues> {
        if filters.board_id.as_deref().is_none_or(str::is_empty) {
            return Ok(PagedIssues {
                issues: Vec::new(),
                total: Some(0),
                has_more: false,
            });
        }
        let client = self.api_client().await?;
        let config = client.config().clone();
        let (issues, status_labels) = self.issues_and_status_labels(&client).await?;
        let query = filters.search_text.trim().to_lowercase();
        let mut matching: Vec<IssueSummary> = build_board_issues(&issues, &config, &status_labels)
            .into_iter()
            .filter(|issue| {
                if !filters.statuses.is_empty() && !filters.statuses.contains(&issue.status) {
                    return false;
                }
                if !filters.issue_types.is_empty()
                    && !filters.issue_types.contains(&issue.issue_type)
                {
                    return false;
                }
                if query.is_empty() {
                    return true;
                }
                format!(
                    "{} {} {}",
                    issue.key,
                    issue.summary,
                    issue.description.as_deref().unwrap_or_default()
                )
                .to_lowercase()
                .contains(&query)
            })
            .collect();
        sort_issues_by_updated(&mut matching);
        let total = matching.len();
        let end = start_at.saturating_add(page_size);
        Ok(PagedIssues {
            issues: matching
                .into_iter()
                .skip(start_at)
                .take(page_size)
                .collect(),
            total: Some(u32::try_from(total).unwrap_or(u32::MAX)),
            has_more: end < total,
        })
    }

    async fn get_filter_metadata(&self, filters: &IssueFilters) -> TrackerResult<FilterMetadata> {
        let metadata_filters = IssueFilters {
            statuses: Vec::new(),
            issue_types: Vec::new(),
            ..filters.clone()
        };
        let page = self.get_issues(&metadata_filters, 0, usize::MAX).await?;
        let sorted_unique = |values: BTreeSet<String>| {
            let mut list: Vec<String> = values.into_iter().collect();
            list.sort_by(|left, right| locale_compare(left, right));
            list
        };
        Ok(FilterMetadata {
            statuses: sorted_unique(page.issues.iter().map(|i| i.status.clone()).collect()),
            issue_types: sorted_unique(page.issues.iter().map(|i| i.issue_type.clone()).collect()),
        })
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
        let config = self.api_config().await?;
        let project_key = format!("{}/{}", config.owner, config.repo);
        let board = Board {
            id: format!("github:{project_key}"),
            name: project_key.clone(),
            board_type: "issue-board".to_string(),
            created_by: None,
            created_at: None,
            project_key: Some(project_key),
            project_name: Some(config.repo.clone()),
            location_name: Some(self.configured_base_url()),
            connection_id: None,
            availability: None,
            availability_message: None,
            issue_creation: None,
            raw: None,
        };
        Ok(if matches_board_filters(&board, filters) {
            vec![board]
        } else {
            Vec::new()
        })
    }

    async fn get_board_details(&self, board: &Board) -> TrackerResult<BoardDetails> {
        let client = self.api_client().await?;
        let config = client.config().clone();
        let (issues, status_labels) = self.issues_and_status_labels(&client).await?;
        let columns = build_board_columns(&status_labels);
        let board_issues = build_board_issues(&issues, &config, &status_labels);

        let mut issues_by_status: HashMap<&str, Vec<IssueSummary>> = HashMap::new();
        for issue in &board_issues {
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
        Ok(BoardDetails {
            board: Board {
                project_key: Some(format!("{}/{}", config.owner, config.repo)),
                project_name: Some(config.repo.clone()),
                ..board.clone()
            },
            columns,
            issues: board_issues,
            column_status_order: Some(column_status_order),
        })
    }

    async fn create_board(&self, _input: &CreateBoardInput) -> TrackerResult<Board> {
        Err("GitHub mode does not support creating boards. The connection's repository is the board.".to_string())
    }

    async fn update_board(
        &self,
        _board_id: &str,
        _input: &UpdateBoardInput,
    ) -> TrackerResult<Board> {
        Err("GitHub mode does not support updating boards. The connection's repository is the board.".to_string())
    }

    async fn delete_board(&self, _board_id: &str) -> TrackerResult<()> {
        Err(
            "GitHub mode does not support deleting boards. Remove the connection instead."
                .to_string(),
        )
    }

    async fn get_issue(&self, issue_key: &str) -> TrackerResult<IssueDetails> {
        let issue_number = parse_github_issue_key(issue_key)?;
        let client = self.api_client().await?;
        let config = client.config().clone();
        let (issue, comments, status_labels) = tokio::try_join!(
            async { client.get_issue(issue_number).await.map_err(String::from) },
            async {
                client
                    .list_issue_comments(issue_number)
                    .await
                    .map_err(String::from)
            },
            self.ensure_status_labels(&client)
        )?;
        let column = resolve_issue_column(&issue, &status_labels);
        Ok(IssueDetails {
            summary: to_issue_summary(&issue, &config, &column),
            transitions: Some(build_board_transitions(&issue, &status_labels)),
            comments: Some(to_issue_comments(comments)),
            linked_issues: None,
        })
    }

    async fn create_issue(&self, input: &CreateIssueInput) -> TrackerResult<IssueDetails> {
        if !self.config_store.get_github_allow_issue_creation() {
            return Err(ISSUE_CREATION_DISABLED_ERROR.to_string());
        }
        let summary = input.summary.trim();
        if summary.is_empty() {
            return Err("Summary cannot be empty.".to_string());
        }
        let client = self.api_client().await?;
        let created = client
            .create_issue(&CreateGitHubIssueInput {
                title: summary.to_string(),
                body: input
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|body| !body.is_empty())
                    .map(str::to_string),
                ..CreateGitHubIssueInput::default()
            })
            .await?;
        let config = client.config();
        self.get_issue(&format!(
            "{}/{}#{}",
            config.owner, config.repo, created.number
        ))
        .await
    }

    async fn update_issue(
        &self,
        issue_key: &str,
        input: &UpdateIssueInput,
    ) -> TrackerResult<IssueDetails> {
        let unsupported = unsupported_issue_edit_fields(input);
        if !unsupported.is_empty() {
            return Err(format!(
                "GitHub issue editing currently supports summary, description, and assignee only. Unsupported fields: {}.",
                unsupported.join(", ")
            ));
        }
        let issue_number = parse_github_issue_key(issue_key)?;
        let client = self.api_client().await?;
        client
            .update_issue(
                issue_number,
                &UpdateGitHubIssueInput {
                    title: input.summary.as_deref().map(|s| s.trim().to_string()),
                    body: input.description.clone(),
                    assignees: input
                        .assignee
                        .as_ref()
                        .map(|assignee| parse_assignee_logins(assignee.as_deref())),
                    ..UpdateGitHubIssueInput::default()
                },
            )
            .await?;
        self.get_issue(issue_key).await
    }

    async fn delete_issue(&self, _issue_key: &str) -> TrackerResult<()> {
        Err("GitHub mode does not support deleting issues. Close the issue instead.".to_string())
    }

    async fn add_comment(&self, issue_key: &str, body: &str) -> TrackerResult<()> {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Err("Comment cannot be empty.".to_string());
        }
        let issue_number = parse_github_issue_key(issue_key)?;
        let client = self.api_client().await?;
        client.add_issue_comment(issue_number, trimmed).await?;
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
        let issue_number = parse_github_issue_key(issue_key)?;
        let client = self.api_client().await?;
        let (issue, status_labels) = self.issue_and_status_labels(&client, issue_number).await?;
        Ok(build_board_transitions(&issue, &status_labels))
    }

    async fn transition_issue(&self, issue_key: &str, transition_id: &str) -> TrackerResult<()> {
        let target_column_id = transition_id
            .strip_prefix("github:")
            .unwrap_or(transition_id)
            .trim();
        let issue_number = parse_github_issue_key(issue_key)?;
        let client = self.api_client().await?;
        let (issue, status_labels) = self.issue_and_status_labels(&client, issue_number).await?;
        let target_column = build_board_columns(&status_labels)
            .into_iter()
            .find(|column| column.id == target_column_id)
            .ok_or_else(|| format!("Unknown GitHub board column: {target_column_id}"))?;
        let target_status_value = status_labels
            .iter()
            .find(|label| label.to_lowercase() == target_column.name.to_lowercase());
        let mut next_labels = non_status_labels(&issue);
        if let Some(value) = target_status_value {
            next_labels.push(format!("status: {value}"));
        }
        client
            .update_issue(
                issue_number,
                &UpdateGitHubIssueInput {
                    state: Some(if target_column.id == "closed" {
                        GitHubIssueState::Closed
                    } else {
                        GitHubIssueState::Open
                    }),
                    labels: Some(next_labels),
                    ..UpdateGitHubIssueInput::default()
                },
            )
            .await?;
        Ok(())
    }

    async fn get_browse_url(&self, issue: &IssueSummary) -> TrackerResult<Option<String>> {
        Ok(issue.browse_url.clone())
    }

    async fn get_self_assignee_label(&self) -> TrackerResult<Option<String>> {
        let client = self.api_client().await?;
        let user = client.get_current_user().await?;
        let login = user.login.trim();
        Ok((!login.is_empty()).then(|| login.to_string()))
    }
}

#[cfg(test)]
mod tests;
