//! Folder-backed issue tracker implementation (`packages/core/src/folder/folderService.ts`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::issue_tracker_service::{IssueTrackerService, TrackerResult};
use async_trait::async_trait;
use chrono::Utc;
use praxis_contracts::{
    BackendMode, Board, BoardColumn, BoardDetails, BoardFilters, BoardIssueCreationRestriction,
    ConnectionCheck, ConnectionCheckStatus, CreateBoardInput, CreateIssueInput, FilterMetadata,
    IssueAttachment, IssueComment, IssueDetails, IssueFilters, IssueSummary, PagedIssues,
    ParentIssueReference, ParentItemQueryOptions, Project, ProjectWorkflowStage, UpdateBoardInput,
    UpdateIssueInput, WorkflowStageCategory, WorkflowTransition,
};
use praxis_core::folder::{
    BoardConfigFile, FolderWatcher, GenerateOptions, IssueType, ParsedPlanFolder,
    SupportedPathPlatform, append_comment_to_markdown_file, append_feature_item_table_row,
    compute_feature_rollup_status, discover_plan_folders, extract_comments, folder_mkdir,
    folder_move_file, folder_read_file, folder_write_file, generate_issue_markdown,
    identify_plan_folder, is_own_folder_write, parse_plan_folder, read_board_config_file,
    read_utf8, remove_feature_item_table_row, resolve_plan_dependency_keys, stable_child_key,
    stable_feature_key, stable_story_key, to_stored_folder_path, update_feature_story_table,
    upgrade_markdown_file, watch_folder, write_board_config_file,
    write_description_to_markdown_file, write_idea_transcript_to_markdown_file,
    write_model_to_markdown_file, write_parent_to_markdown_file, write_priority_to_markdown_file,
    write_reported_by_to_markdown_file, write_severity_to_markdown_file,
    write_status_to_markdown_file, write_summary_to_markdown_file,
};
use praxis_core::issues::{
    build_parent_validation_message, get_parent_rule, is_allowed_parent_type,
};
use praxis_core::projects::{default_workflow, normalize_workflow_stages};
use serde::{Deserialize, Serialize};

const FOLDER_CREATION_DISABLED_ERROR: &str = "Issue creation is disabled for this folder. Enable it on the connection to create markdown issues.";
const SECONDARY_ROOT_CREATION_ERROR: &str = "Creating issues in a specific plans root is not supported yet for multi-root folder connections — create from the primary board instead.";

fn now_iso_millis() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn category_for_status(name: &str, workflow: &[ProjectWorkflowStage]) -> String {
    match workflow
        .iter()
        .find(|s| s.name == name)
        .and_then(|s| s.category)
    {
        Some(WorkflowStageCategory::Indeterminate) => "indeterminate".to_string(),
        Some(WorkflowStageCategory::Done) => "done".to_string(),
        _ => "todo".to_string(),
    }
}

fn transitions_from(
    current_status: &str,
    workflow: &[ProjectWorkflowStage],
) -> Vec<WorkflowTransition> {
    workflow
        .iter()
        .map(|s| s.name.as_str())
        .filter(|s| *s != current_status)
        .enumerate()
        .map(|(i, s)| WorkflowTransition {
            id: format!(
                "lf-{i}-{}",
                s.replace(char::is_whitespace, "-").to_lowercase()
            ),
            name: format!("Move to {s}"),
            to_status: Some(s.to_string()),
            raw: None,
        })
        .collect()
}

fn pad_feature_id(feature_id: u32) -> String {
    format!("{feature_id:02}")
}

fn slugify_path_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last_dash = true;
    for ch in value.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "item".to_string()
    } else {
        trimmed.to_string()
    }
}

fn build_feature_directory_name(feature_id: u32, summary: &str) -> String {
    format!(
        "feature-{}-{}",
        pad_feature_id(feature_id),
        slugify_path_segment(summary)
    )
}

fn child_file_prefix(issue_type: IssueType) -> &'static str {
    match issue_type {
        IssueType::Idea => "idea",
        IssueType::Story => "story",
        IssueType::Task => "task",
        IssueType::Bug => "bug",
        IssueType::Feature => "feature",
    }
}

fn build_child_file_name(
    issue_type: IssueType,
    feature_id: u32,
    child_seq: u32,
    summary: &str,
) -> String {
    format!(
        "{}-{}-{}-{}.md",
        child_file_prefix(issue_type),
        pad_feature_id(feature_id),
        child_seq,
        slugify_path_segment(summary)
    )
}

#[allow(clippy::too_many_arguments)]
fn build_issue_markdown(
    issue_type: IssueType,
    title: &str,
    description: Option<&str>,
    idea_transcript: Option<&str>,
    created_at_iso: &str,
    parent_key: Option<&str>,
    model: Option<&str>,
    input: Option<&CreateIssueInput>,
) -> String {
    let mut field_values = HashMap::new();
    if let Some(inp) = input {
        if let Some(p) = inp
            .priority
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            field_values.insert("Priority".to_string(), p.to_string());
        }
        if let Some(s) = inp
            .severity
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            field_values.insert("Severity".to_string(), s.to_string());
        }
    }
    let section_bodies = input
        .and_then(|inp| inp.sections.clone())
        .unwrap_or_default();
    let origin = input
        .and_then(|inp| inp.origin)
        .map(|_| "capture".to_string());

    generate_issue_markdown(
        issue_type,
        title,
        &GenerateOptions {
            description: description.map(ToString::to_string),
            idea_transcript: idea_transcript.map(ToString::to_string),
            created_at: Some(created_at_iso.to_string()),
            parent_key: parent_key.map(ToString::to_string),
            model: model.map(ToString::to_string),
            field_values,
            section_bodies,
            origin,
        },
    )
}

/// Stable short djb2 hash of a plans-root path (`hashRootPath` in `folderService.ts`).
#[must_use]
pub fn hash_root_path(root_path: &str) -> String {
    let normalized =
        to_stored_folder_path(root_path, SupportedPathPlatform::current()).to_lowercase();
    let mut hash: u32 = 5381;
    for unit in normalized.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_add(hash)
            .wrapping_add(u32::from(unit));
    }
    format!("{hash:08x}")
}

/// Configuration provider for [`FolderService`].
pub trait FolderConfigProvider: Send + Sync {
    fn get_default_page_size(&self) -> usize {
        50
    }
    fn get_folder_roots(&self) -> Vec<String>;
    fn get_folder_project_key(&self) -> String;
    fn get_folder_project_name(&self) -> String;
    fn get_folder_allow_issue_creation(&self) -> bool;
    fn get_ai_default_model(&self) -> String {
        String::new()
    }
    fn prefers_configured_identity(&self) -> bool {
        false
    }
}

/// Static configuration struct implementing [`FolderConfigProvider`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticFolderConfig {
    #[serde(default = "default_page_size")]
    pub default_page_size: usize,
    pub folder_roots: Vec<String>,
    #[serde(default)]
    pub project_key: String,
    #[serde(default)]
    pub project_name: String,
    #[serde(default)]
    pub allow_issue_creation: bool,
    #[serde(default)]
    pub ai_default_model: String,
    #[serde(default)]
    pub prefers_configured_identity: bool,
}

const fn default_page_size() -> usize {
    50
}

impl Default for StaticFolderConfig {
    fn default() -> Self {
        Self {
            default_page_size: 50,
            folder_roots: Vec::new(),
            project_key: "LIVE".to_string(),
            project_name: "Folder".to_string(),
            allow_issue_creation: false,
            ai_default_model: String::new(),
            prefers_configured_identity: false,
        }
    }
}

impl FolderConfigProvider for StaticFolderConfig {
    fn get_default_page_size(&self) -> usize {
        self.default_page_size
    }
    fn get_folder_roots(&self) -> Vec<String> {
        self.folder_roots.clone()
    }
    fn get_folder_project_key(&self) -> String {
        self.project_key.clone()
    }
    fn get_folder_project_name(&self) -> String {
        self.project_name.clone()
    }
    fn get_folder_allow_issue_creation(&self) -> bool {
        self.allow_issue_creation
    }
    fn get_ai_default_model(&self) -> String {
        self.ai_default_model.clone()
    }
    fn prefers_configured_identity(&self) -> bool {
        self.prefers_configured_identity
    }
}

/// Event fired when an external file edit adds a new comment to a ticket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCommentEvent {
    pub issue_key: String,
    pub author: String,
    pub body: String,
}

/// Options for [`FolderService::sync_board_config_to_folder`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBoardConfigOptions {
    #[serde(default)]
    pub include_allow_issue_creation: bool,
    #[serde(default)]
    pub workflow: Option<Vec<ProjectWorkflowStage>>,
}

#[derive(Debug, Clone)]
struct LiveIssue {
    summary_model: IssueSummary,
    source_path: String,
    feature_id: Option<u32>,
    feature_dir_name: Option<String>,
}

#[derive(Debug, Clone)]
struct FolderBoardRoot {
    id: String,
    name: String,
    root_path: String,
    #[allow(dead_code)]
    features_root_path: String,
    project_key: String,
    project_name: String,
}

#[derive(Default)]
struct FolderServiceState {
    issues: Vec<LiveIssue>,
    project_key: String,
    project_name: String,
    board_config: BoardConfigFile,
    plans_root_path: Option<String>,
    features_root_path: Option<String>,
    configured_roots: Vec<String>,
    board_roots: Vec<FolderBoardRoot>,
    issues_by_root: HashMap<String, Vec<LiveIssue>>,
    loaded: bool,
    watchers: Vec<FolderWatcher>,
    comment_count_snapshot: HashMap<String, usize>,
}

/// Folder-backed [`IssueTrackerService`](crate::IssueTrackerService) implementation.
pub struct FolderService {
    config_store: Arc<dyn FolderConfigProvider>,
    state: Arc<Mutex<FolderServiceState>>,
}

impl FolderService {
    /// Creates a new [`FolderService`] backed by `config_store`.
    #[must_use]
    pub fn new(config_store: Arc<dyn FolderConfigProvider>) -> Self {
        Self {
            config_store,
            state: Arc::new(Mutex::new(FolderServiceState::default())),
        }
    }

    /// Creates a new [`FolderService`] from a [`StaticFolderConfig`].
    #[must_use]
    pub fn from_static(config: StaticFolderConfig) -> Self {
        Self::new(Arc::new(config))
    }

    fn current_workflow(board_config: &BoardConfigFile) -> Vec<ProjectWorkflowStage> {
        match board_config.workflow.as_deref() {
            Some(wf) if !wf.is_empty() => normalize_workflow_stages(Some(wf)),
            _ => default_workflow(),
        }
    }

    fn status_names(board_config: &BoardConfigFile) -> Vec<String> {
        Self::current_workflow(board_config)
            .into_iter()
            .map(|s| s.name)
            .collect()
    }

    fn allows_issue_creation(&self, board_config: &BoardConfigFile) -> bool {
        board_config
            .allow_issue_creation
            .unwrap_or_else(|| self.config_store.get_folder_allow_issue_creation())
    }

    fn resolve_key(&self, config: &BoardConfigFile) -> String {
        let configured = self.config_store.get_folder_project_key();
        if self.config_store.prefers_configured_identity() && !configured.is_empty() {
            return configured;
        }
        config.project_key.clone().unwrap_or_else(|| {
            if configured.is_empty() {
                "LIVE".to_string()
            } else {
                configured
            }
        })
    }

    fn resolve_name(&self, config: &BoardConfigFile) -> String {
        let configured = self.config_store.get_folder_project_name();
        if self.config_store.prefers_configured_identity() && !configured.is_empty() {
            return configured;
        }
        config.project_name.clone().unwrap_or_else(|| {
            if configured.is_empty() {
                "Folder".to_string()
            } else {
                configured
            }
        })
    }

    /// Materializes the connection's project identity into `<plansRoot>/board.praxis.json`.
    pub fn sync_board_config_to_folder(
        &self,
        options: Option<&SyncBoardConfigOptions>,
    ) -> Result<(), String> {
        self.ensure_loaded()?;
        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        let Some(ref plans_root_str) = guard.plans_root_path else {
            return Ok(());
        };
        let plans_root = PathBuf::from(plans_root_str);
        let workflow = options
            .and_then(|o| o.workflow.clone())
            .or_else(|| guard.board_config.workflow.clone());
        let configured_key = self.config_store.get_folder_project_key();
        let configured_name = self.config_store.get_folder_project_name();

        let next = BoardConfigFile {
            project_key: if configured_key.is_empty() {
                None
            } else {
                Some(configured_key)
            },
            project_name: if configured_name.is_empty() {
                None
            } else {
                Some(configured_name)
            },
            allow_issue_creation: if options.is_some_and(|o| o.include_allow_issue_creation) {
                Some(self.config_store.get_folder_allow_issue_creation())
            } else {
                None
            },
            workflow: workflow
                .filter(|w| !w.is_empty())
                .map(|w| normalize_workflow_stages(Some(&w))),
        };

        write_board_config_file(&plans_root, &next).map_err(|e| e.to_string())?;
        let updated_cfg = read_board_config_file(&plans_root);
        guard.project_key = self.resolve_key(&updated_cfg);
        guard.project_name = self.resolve_name(&updated_cfg);
        guard.board_config = updated_cfg;
        Ok(())
    }

    /// Returns the default page size for paginated issue queries.
    #[must_use]
    pub fn get_default_page_size(&self) -> usize {
        self.config_store.get_default_page_size()
    }

    /// Clears cached issues and reloads from disk.
    pub fn reset(&self) -> Result<(), String> {
        if let Ok(mut guard) = self.state.lock() {
            guard.loaded = false;
            guard.issues.clear();
            guard.board_roots.clear();
            guard.issues_by_root.clear();
        }
        self.ensure_loaded()
    }

    /// Closes active file watchers.
    pub fn dispose(&self) {
        if let Ok(mut guard) = self.state.lock() {
            for mut watcher in guard.watchers.drain(..) {
                watcher.close();
            }
        }
    }

    /// Checks whether the folder connection can load its configured roots.
    #[must_use]
    pub fn check_connection(&self) -> ConnectionCheck {
        match self.ensure_loaded() {
            Ok(()) => {
                let Ok(guard) = self.state.lock() else {
                    return ConnectionCheck {
                        status: ConnectionCheckStatus::Error,
                        message: "Folder error: state lock poisoned".to_string(),
                        tool_count: 0,
                        project_count: None,
                        server_name: None,
                    };
                };
                let root_display = guard.plans_root_path.as_deref().unwrap_or("(not set)");
                let creation_label = if self.allows_issue_creation(&guard.board_config) {
                    "issue creation enabled"
                } else {
                    "issue creation disabled"
                };
                ConnectionCheck {
                    status: ConnectionCheckStatus::Ok,
                    message: format!(
                        "Folder: {} items from {root_display} ({creation_label})",
                        guard.issues.len()
                    ),
                    tool_count: 0,
                    project_count: Some(1),
                    server_name: None,
                }
            }
            Err(msg) => ConnectionCheck {
                status: ConnectionCheckStatus::Error,
                message: format!("Folder error: {msg}"),
                tool_count: 0,
                project_count: None,
                server_name: None,
            },
        }
    }

    /// Returns the folder board's project descriptor.
    pub fn get_projects(&self) -> Result<Vec<Project>, String> {
        self.ensure_loaded()?;
        let guard = self.state.lock().map_err(|e| e.to_string())?;
        Ok(vec![Project {
            id: None,
            key: guard.project_key.clone(),
            name: guard.project_name.clone(),
        }])
    }

    /// Returns a filtered page of issues.
    pub fn get_issues(
        &self,
        filters: &IssueFilters,
        start_at: usize,
        page_size: usize,
    ) -> Result<PagedIssues, String> {
        self.ensure_loaded()?;
        let guard = self.state.lock().map_err(|e| e.to_string())?;
        let mut list: Vec<IssueSummary> = if let Some(ref board_id) = filters.board_id
            && !board_id.is_empty()
        {
            if let Some(root) = guard.board_roots.iter().find(|r| &r.id == board_id) {
                guard
                    .issues_by_root
                    .get(&root.root_path)
                    .map(|v| v.iter().map(|li| li.summary_model.clone()).collect())
                    .unwrap_or_default()
            } else {
                Vec::new()
            }
        } else {
            guard
                .issues
                .iter()
                .map(|li| li.summary_model.clone())
                .collect()
        };

        if !filters.project_keys.is_empty() {
            let pks: HashSet<&str> = filters.project_keys.iter().map(String::as_str).collect();
            list.retain(|i| pks.contains(i.project_key.as_str()));
        }
        if !filters.statuses.is_empty() {
            let ss: HashSet<&str> = filters.statuses.iter().map(String::as_str).collect();
            list.retain(|i| ss.contains(i.status.as_str()));
        }
        if !filters.issue_types.is_empty() {
            let ts: HashSet<&str> = filters.issue_types.iter().map(String::as_str).collect();
            list.retain(|i| ts.contains(i.issue_type.as_str()));
        }
        if !filters.search_text.is_empty() {
            let q = filters.search_text.to_lowercase();
            list.retain(|i| {
                i.key.to_lowercase().contains(&q)
                    || i.summary.to_lowercase().contains(&q)
                    || i.description
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&q)
            });
        }
        if let Some(ref parent_key) = filters.parent_key
            && !parent_key.is_empty()
        {
            list.retain(|i| i.parent_key.as_deref() == Some(parent_key.as_str()));
        }

        let total = list.len();
        let page: Vec<IssueSummary> = list.into_iter().skip(start_at).take(page_size).collect();
        Ok(PagedIssues {
            issues: page,
            total: Some(u32::try_from(total).unwrap_or(u32::MAX)),
            has_more: start_at + page_size < total,
        })
    }

    /// Returns distinct statuses and issue types across the loaded issues.
    pub fn get_filter_metadata(&self, _filters: &IssueFilters) -> Result<FilterMetadata, String> {
        self.ensure_loaded()?;
        let guard = self.state.lock().map_err(|e| e.to_string())?;
        let mut statuses = Vec::new();
        let mut seen_statuses = HashSet::new();
        for s in Self::status_names(&guard.board_config) {
            if seen_statuses.insert(s.clone()) {
                statuses.push(s);
            }
        }
        for i in &guard.issues {
            if seen_statuses.insert(i.summary_model.status.clone()) {
                statuses.push(i.summary_model.status.clone());
            }
        }

        let mut issue_types = Vec::new();
        let mut seen_types = HashSet::new();
        for i in &guard.issues {
            if seen_types.insert(i.summary_model.issue_type.clone()) {
                issue_types.push(i.summary_model.issue_type.clone());
            }
        }

        Ok(FilterMetadata {
            statuses,
            issue_types,
        })
    }

    /// Returns candidate parent Feature items.
    pub fn get_parent_items(
        &self,
        filters: &IssueFilters,
        search_text: Option<&str>,
        _options: Option<&ParentItemQueryOptions>,
    ) -> Result<Vec<IssueSummary>, String> {
        self.ensure_loaded()?;
        let guard = self.state.lock().map_err(|e| e.to_string())?;
        let mut features: Vec<IssueSummary> = guard
            .issues
            .iter()
            .filter(|i| i.summary_model.issue_type == "Feature")
            .map(|i| i.summary_model.clone())
            .collect();
        if !filters.project_keys.is_empty() {
            let pks: HashSet<&str> = filters.project_keys.iter().map(String::as_str).collect();
            features.retain(|i| pks.contains(i.project_key.as_str()));
        }
        if !filters.statuses.is_empty() {
            let ss: HashSet<&str> = filters.statuses.iter().map(String::as_str).collect();
            features.retain(|i| ss.contains(i.status.as_str()));
        }
        if let Some(q) = search_text.map(str::trim).filter(|s| !s.is_empty()) {
            let lower = q.to_lowercase();
            features.retain(|i| {
                i.key.to_lowercase().contains(&lower) || i.summary.to_lowercase().contains(&lower)
            });
        }
        Ok(features)
    }

    /// Returns the discovered boards for this folder connection.
    pub fn get_boards(&self, _filters: &BoardFilters) -> Result<Vec<Board>, String> {
        self.ensure_loaded()?;
        let guard = self.state.lock().map_err(|e| e.to_string())?;
        Ok(guard
            .board_roots
            .iter()
            .enumerate()
            .map(|(index, root)| Board {
                id: root.id.clone(),
                name: root.name.clone(),
                board_type: "plan".to_string(),
                created_by: None,
                created_at: None,
                project_key: Some(root.project_key.clone()),
                project_name: Some(root.project_name.clone()),
                location_name: Some(root.root_path.clone()),
                connection_id: None,
                availability: None,
                availability_message: None,
                issue_creation: if index > 0 {
                    Some(BoardIssueCreationRestriction {
                        allowed: false,
                        reason: SECONDARY_ROOT_CREATION_ERROR.to_string(),
                    })
                } else {
                    None
                },
                raw: None,
            })
            .collect())
    }

    /// Returns the columns and issues for `board`.
    pub fn get_board_details(&self, board: &Board) -> Result<BoardDetails, String> {
        self.ensure_loaded()?;
        let guard = self.state.lock().map_err(|e| e.to_string())?;
        let workflow = Self::current_workflow(&guard.board_config);
        let status_names = Self::status_names(&guard.board_config);
        let fallback_status = status_names
            .first()
            .cloned()
            .unwrap_or_else(|| "Backlog".to_string());

        let issues: Vec<IssueSummary> =
            if let Some(root) = guard.board_roots.iter().find(|r| r.id == board.id) {
                guard
                    .issues_by_root
                    .get(&root.root_path)
                    .map(|v| v.iter().map(|li| li.summary_model.clone()).collect())
                    .unwrap_or_default()
            } else {
                guard
                    .issues
                    .iter()
                    .map(|li| li.summary_model.clone())
                    .collect()
            };

        let mut column_map: HashMap<String, Vec<IssueSummary>> = HashMap::new();
        for s in &status_names {
            column_map.insert(s.clone(), Vec::new());
        }
        for issue in &issues {
            let target_col = if column_map.contains_key(&issue.status) {
                issue.status.clone()
            } else {
                fallback_status.clone()
            };
            if let Some(bucket) = column_map.get_mut(&target_col) {
                bucket.push(issue.clone());
            }
        }

        let columns: Vec<BoardColumn> = status_names
            .iter()
            .map(|s| BoardColumn {
                id: s.clone(),
                name: s.clone(),
                status_category: Some(category_for_status(s, &workflow)),
                issues: column_map.remove(s).unwrap_or_default(),
            })
            .collect();

        Ok(BoardDetails {
            board: board.clone(),
            columns,
            issues,
            column_status_order: Some(status_names),
        })
    }

    /// Returns full details for `issue_key`.
    pub fn get_issue(&self, issue_key: &str) -> Result<IssueDetails, String> {
        self.ensure_loaded()?;
        let guard = self.state.lock().map_err(|e| e.to_string())?;
        let issue = guard
            .issues
            .iter()
            .find(|i| i.summary_model.key == issue_key)
            .ok_or_else(|| format!("Issue {issue_key} not found"))?;
        let workflow = Self::current_workflow(&guard.board_config);
        let transitions = transitions_from(&issue.summary_model.status, &workflow);
        let parent_issue = issue
            .summary_model
            .parent_key
            .as_deref()
            .and_then(|pk| guard.issues.iter().find(|c| c.summary_model.key == pk))
            .map(|p| ParentIssueReference {
                key: p.summary_model.key.clone(),
                summary: Some(p.summary_model.summary.clone()),
                issue_type: Some(p.summary_model.issue_type.clone()),
                description: p.summary_model.description.clone(),
            });
        let comments = Self::read_comments_from_file(issue);
        let mut summary = issue.summary_model.clone();
        summary.parent_issue = parent_issue;
        Ok(IssueDetails {
            summary,
            transitions: Some(transitions),
            comments: Some(comments),
            linked_issues: None,
        })
    }

    /// Creates a new markdown issue in the primary plans root.
    pub fn create_issue(&self, input: &CreateIssueInput) -> Result<IssueDetails, String> {
        self.ensure_loaded()?;
        {
            let mut guard = self.state.lock().map_err(|e| e.to_string())?;
            if !self.allows_issue_creation(&guard.board_config) {
                return Err(FOLDER_CREATION_DISABLED_ERROR.to_string());
            }
            if let Some(ref board_id) = input.board_id
                && !board_id.is_empty()
                && guard.board_roots.len() > 1
                && let Some(target) = guard.board_roots.iter().find(|r| &r.id == board_id)
                && Some(&target.id) != guard.board_roots.first().map(|r| &r.id)
            {
                return Err(SECONDARY_ROOT_CREATION_ERROR.to_string());
            }
            let Some(features_root_str) = guard.features_root_path.clone() else {
                return Err("Folder features root is not configured.".to_string());
            };
            let features_root = PathBuf::from(&features_root_str);

            let Some(issue_type) = IssueType::parse_loose(&input.issue_type) else {
                return Err(format!(
                    "Folder mode supports creating Feature, Story, Task, and Bug items. \"{}\" is not supported.",
                    input.issue_type
                ));
            };

            let project_key = input.project_key.trim().to_string();
            if project_key != guard.project_key {
                return Err(format!(
                    "Project {project_key} is not available in Folder mode."
                ));
            }

            let summary = input.summary.trim().to_string();
            if summary.is_empty() {
                return Err("Summary cannot be empty.".to_string());
            }
            let description = input
                .description
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let idea_transcript = input
                .idea_transcript
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let created_at = now_iso_millis();
            let default_model = {
                let m = self.config_store.get_ai_default_model();
                if m.is_empty() { None } else { Some(m) }
            };

            if issue_type == IssueType::Feature {
                if input
                    .parent_key
                    .as_deref()
                    .is_some_and(|pk| !pk.trim().is_empty())
                {
                    return Err("Feature items cannot have a parent.".to_string());
                }
                let feature_id = Self::get_next_feature_id(&guard.issues);
                let feature_dir_path =
                    features_root.join(build_feature_directory_name(feature_id, &summary));
                let feature_file_path = feature_dir_path.join("feature.md");

                folder_mkdir(&feature_dir_path).map_err(|e| e.to_string())?;
                folder_write_file(
                    &feature_file_path,
                    &build_issue_markdown(
                        issue_type,
                        &summary,
                        description,
                        None,
                        &created_at,
                        None,
                        default_model.as_deref(),
                        Some(input),
                    ),
                )
                .map_err(|e| e.to_string())?;

                self.load_from_disk_locked(&mut guard, None)?;
                let created_key = stable_feature_key(&guard.project_key, feature_id);
                drop(guard);
                return self.get_issue(&created_key);
            }

            let mut resolved_parent_key = input
                .parent_key
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);

            if resolved_parent_key.is_none()
                && let Some(new_parent_summary) = input
                    .new_parent_summary
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            {
                let new_feature_id = Self::get_next_feature_id(&guard.issues);
                let new_feature_dir_path = features_root.join(build_feature_directory_name(
                    new_feature_id,
                    new_parent_summary,
                ));
                folder_mkdir(&new_feature_dir_path).map_err(|e| e.to_string())?;
                folder_write_file(
                    &new_feature_dir_path.join("feature.md"),
                    &build_issue_markdown(
                        IssueType::Feature,
                        new_parent_summary,
                        None,
                        None,
                        &created_at,
                        None,
                        default_model.as_deref(),
                        None,
                    ),
                )
                .map_err(|e| e.to_string())?;
                self.load_from_disk_locked(&mut guard, None)?;
                resolved_parent_key = Some(stable_feature_key(&project_key, new_feature_id));
            }

            let parent_feature = Self::resolve_create_parent(
                &guard.issues,
                &project_key,
                issue_type,
                resolved_parent_key.as_deref(),
            )?;
            let parent_fid = parent_feature
                .feature_id
                .ok_or_else(|| "Parent feature is missing featureId".to_string())?;
            let parent_dir_name = parent_feature.feature_dir_name.clone().ok_or_else(|| {
                format!(
                    "Feature {} is missing its plans directory.",
                    parent_feature.summary_model.key
                )
            })?;
            let child_seq = Self::get_next_child_sequence(&guard.issues, parent_fid, issue_type);
            let child_file_path = features_root
                .join(&parent_dir_name)
                .join(build_child_file_name(
                    issue_type, parent_fid, child_seq, &summary,
                ));

            folder_write_file(
                &child_file_path,
                &build_issue_markdown(
                    issue_type,
                    &summary,
                    description,
                    if issue_type == IssueType::Idea {
                        idea_transcript
                    } else {
                        None
                    },
                    &created_at,
                    Some(&parent_feature.summary_model.key),
                    default_model.as_deref(),
                    Some(input),
                ),
            )
            .map_err(|e| e.to_string())?;

            let first_status = Self::status_names(&guard.board_config)
                .into_iter()
                .next()
                .unwrap_or_else(|| "Backlog".to_string());
            let _ = append_feature_item_table_row(
                Path::new(&parent_feature.source_path),
                &format!("{}.{child_seq}", pad_feature_id(parent_fid)),
                issue_type.as_str(),
                &summary,
                &first_status,
            );

            self.load_from_disk_locked(&mut guard, None)?;
            let created_key = stable_child_key(
                &guard.project_key,
                issue_type.as_str(),
                parent_fid,
                child_seq,
            );
            drop(guard);
            self.get_issue(&created_key)
        }
    }

    /// Updates an existing markdown issue.
    pub fn update_issue(
        &self,
        issue_key: &str,
        input: &UpdateIssueInput,
    ) -> Result<IssueDetails, String> {
        self.ensure_loaded()?;
        let target_key = {
            let mut guard = self.state.lock().map_err(|e| e.to_string())?;
            let issue_idx = guard
                .issues
                .iter()
                .position(|i| i.summary_model.key == issue_key)
                .ok_or_else(|| format!("Issue {issue_key} not found"))?;

            if let Some(ref assignee_opt) = input.assignee {
                guard.issues[issue_idx].summary_model.assignee = assignee_opt.clone();
            }

            if let Some(ref parent_patch) = input.parent_key {
                let current_type_str = guard.issues[issue_idx].summary_model.issue_type.clone();
                let Some(issue_type) = IssueType::parse_loose(&current_type_str) else {
                    return Err(build_parent_validation_message(
                        Some(&current_type_str),
                        BackendMode::Folder,
                        None,
                    ));
                };
                if issue_type == IssueType::Feature {
                    return Err(build_parent_validation_message(
                        Some(&current_type_str),
                        BackendMode::Folder,
                        None,
                    ));
                }

                let next_parent_key = parent_patch
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let issue_project_key = guard.issues[issue_idx].summary_model.project_key.clone();
                let parent_feature = Self::resolve_create_parent(
                    &guard.issues,
                    &issue_project_key,
                    issue_type,
                    next_parent_key,
                )?;

                if next_parent_key != guard.issues[issue_idx].summary_model.parent_key.as_deref() {
                    let previous_path = guard.issues[issue_idx].source_path.clone();
                    let previous_parent = guard.issues[issue_idx]
                        .summary_model
                        .parent_key
                        .as_deref()
                        .and_then(|pk| {
                            guard
                                .issues
                                .iter()
                                .find(|c| c.summary_model.key == pk)
                                .cloned()
                        });
                    let parent_fid = parent_feature.feature_id.unwrap_or(0);
                    let next_child_seq =
                        Self::get_next_child_sequence(&guard.issues, parent_fid, issue_type);
                    let summary_for_name = input
                        .summary
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&guard.issues[issue_idx].summary_model.summary)
                        .to_string();
                    let parent_dir = Path::new(&parent_feature.source_path)
                        .parent()
                        .unwrap_or_else(|| Path::new("."));
                    let next_path = parent_dir.join(build_child_file_name(
                        issue_type,
                        parent_fid,
                        next_child_seq,
                        &summary_for_name,
                    ));

                    folder_move_file(Path::new(&previous_path), &next_path)
                        .map_err(|e| e.to_string())?;

                    if let Some(prev_p) = previous_parent
                        && let (Some(prev_fid), Some(prev_seq)) = (
                            guard.issues[issue_idx].feature_id,
                            guard.issues[issue_idx].summary_model.child_seq,
                        )
                    {
                        let _ = remove_feature_item_table_row(
                            Path::new(&prev_p.source_path),
                            &format!("{}.{prev_seq}", pad_feature_id(prev_fid)),
                            &guard.issues[issue_idx].summary_model.issue_type,
                        );
                    }

                    let _ = append_feature_item_table_row(
                        Path::new(&parent_feature.source_path),
                        &format!("{}.{next_child_seq}", pad_feature_id(parent_fid)),
                        issue_type.as_str(),
                        &summary_for_name,
                        &guard.issues[issue_idx].summary_model.status,
                    );
                    let _ = write_parent_to_markdown_file(
                        &next_path,
                        &parent_feature.summary_model.key,
                    );

                    let new_key = if issue_type == IssueType::Story {
                        stable_story_key(&issue_project_key, parent_fid, next_child_seq)
                    } else {
                        stable_child_key(
                            &issue_project_key,
                            issue_type.as_str(),
                            parent_fid,
                            next_child_seq,
                        )
                    };
                    let item = &mut guard.issues[issue_idx];
                    item.summary_model.key = new_key;
                    item.summary_model.parent_key = Some(parent_feature.summary_model.key);
                    item.feature_id = parent_feature.feature_id;
                    item.feature_dir_name = parent_feature.feature_dir_name;
                    item.summary_model.child_seq = Some(next_child_seq);
                    item.source_path = next_path.to_string_lossy().to_string();
                    item.summary_model.source_path = Some(item.source_path.clone());
                }
            }

            let source_path = PathBuf::from(&guard.issues[issue_idx].source_path);

            if let Some(ref new_summary) = input.summary {
                let written = write_summary_to_markdown_file(&source_path, new_summary)
                    .map_err(|e| e.to_string())?;
                if !written && guard.issues[issue_idx].summary_model.summary != new_summary.trim() {
                    return Err(format!(
                        "Could not update summary in {}.",
                        source_path.display()
                    ));
                }
                guard.issues[issue_idx].summary_model.summary = new_summary.trim().to_string();
            }

            let is_idea = guard.issues[issue_idx].summary_model.issue_type == "Idea";
            if is_idea && (input.description.is_some() || input.idea_transcript.is_some()) {
                let next_desc = input.description.clone().unwrap_or_else(|| {
                    guard.issues[issue_idx]
                        .summary_model
                        .description
                        .clone()
                        .unwrap_or_default()
                });
                let next_trans = input.idea_transcript.clone().unwrap_or_else(|| {
                    guard.issues[issue_idx]
                        .summary_model
                        .idea_transcript
                        .clone()
                        .unwrap_or_default()
                });
                let written =
                    write_idea_transcript_to_markdown_file(&source_path, &next_desc, &next_trans)
                        .map_err(|e| e.to_string())?;
                if !written
                    && guard.issues[issue_idx]
                        .summary_model
                        .description
                        .as_deref()
                        .unwrap_or("")
                        != next_desc
                {
                    return Err(format!(
                        "Could not update description in {}.",
                        source_path.display()
                    ));
                }
                guard.issues[issue_idx].summary_model.description = Some(next_desc);
                guard.issues[issue_idx].summary_model.idea_transcript = Some(next_trans);
            } else if let Some(ref new_desc) = input.description {
                let written = write_description_to_markdown_file(&source_path, new_desc)
                    .map_err(|e| e.to_string())?;
                if !written
                    && guard.issues[issue_idx]
                        .summary_model
                        .description
                        .as_deref()
                        .unwrap_or("")
                        != new_desc
                {
                    return Err(format!(
                        "Could not update description in {}.",
                        source_path.display()
                    ));
                }
                guard.issues[issue_idx].summary_model.description = Some(new_desc.clone());
            }

            if let Some(ref new_priority) = input.priority {
                let written = write_priority_to_markdown_file(&source_path, new_priority)
                    .map_err(|e| e.to_string())?;
                if !written
                    && guard.issues[issue_idx].summary_model.priority.as_deref()
                        != Some(new_priority.as_str())
                {
                    return Err(format!(
                        "Could not update priority in {}.",
                        source_path.display()
                    ));
                }
                guard.issues[issue_idx].summary_model.priority = Some(new_priority.clone());
            }

            if let Some(ref new_model) = input.model {
                let written = write_model_to_markdown_file(&source_path, new_model)
                    .map_err(|e| e.to_string())?;
                if !written
                    && guard.issues[issue_idx].summary_model.model.as_deref()
                        != Some(new_model.as_str())
                {
                    return Err(format!(
                        "Could not update model in {}.",
                        source_path.display()
                    ));
                }
                guard.issues[issue_idx].summary_model.model = Some(new_model.clone());
            }

            if let Some(ref new_severity) = input.severity {
                let written = write_severity_to_markdown_file(&source_path, new_severity)
                    .map_err(|e| e.to_string())?;
                if !written
                    && guard.issues[issue_idx].summary_model.severity.as_deref()
                        != Some(new_severity.as_str())
                {
                    return Err(format!(
                        "Could not update severity in {}.",
                        source_path.display()
                    ));
                }
                guard.issues[issue_idx].summary_model.severity = Some(new_severity.clone());
            }

            if let Some(ref new_reported_by) = input.reported_by {
                let written = write_reported_by_to_markdown_file(&source_path, new_reported_by)
                    .map_err(|e| e.to_string())?;
                if !written
                    && guard.issues[issue_idx].summary_model.reported_by.as_deref()
                        != Some(new_reported_by.as_str())
                {
                    return Err(format!(
                        "Could not update reported by in {}.",
                        source_path.display()
                    ));
                }
                guard.issues[issue_idx].summary_model.reported_by = Some(new_reported_by.clone());
            }

            guard.issues[issue_idx].summary_model.key.clone()
        };

        self.get_issue(&target_key)
    }

    /// Appends a comment to `issue_key`'s markdown file.
    pub fn add_comment(&self, issue_key: &str, body: &str) -> Result<(), String> {
        let comment_body = body.trim();
        if comment_body.is_empty() {
            return Err("Comment cannot be empty.".to_string());
        }
        self.ensure_loaded()?;
        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        let issue = guard
            .issues
            .iter()
            .find(|i| i.summary_model.key == issue_key)
            .ok_or_else(|| format!("Issue {issue_key} not found"))?;
        let author = issue
            .summary_model
            .assignee
            .clone()
            .filter(|a| !a.is_empty())
            .unwrap_or_else(|| issue.summary_model.key.clone());
        let source_path = PathBuf::from(&issue.source_path);
        append_comment_to_markdown_file(&source_path, &author, comment_body)
            .map_err(|e| e.to_string())?;
        let prev = guard
            .comment_count_snapshot
            .get(issue_key)
            .copied()
            .unwrap_or(0);
        guard
            .comment_count_snapshot
            .insert(issue_key.to_string(), prev + 1);
        Ok(())
    }

    /// Lists available transitions for `issue_key`.
    pub fn get_transitions(&self, issue_key: &str) -> Result<Vec<WorkflowTransition>, String> {
        self.ensure_loaded()?;
        let guard = self.state.lock().map_err(|e| e.to_string())?;
        let Some(issue) = guard
            .issues
            .iter()
            .find(|i| i.summary_model.key == issue_key)
        else {
            return Ok(Vec::new());
        };
        let workflow = Self::current_workflow(&guard.board_config);
        Ok(transitions_from(&issue.summary_model.status, &workflow))
    }

    /// Moves `issue_key` along `transition_id` and updates parent feature rollup tables.
    pub fn transition_issue(&self, issue_key: &str, transition_id: &str) -> Result<(), String> {
        self.ensure_loaded()?;
        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        let issue_idx = guard
            .issues
            .iter()
            .position(|i| i.summary_model.key == issue_key)
            .ok_or_else(|| format!("Issue {issue_key} not found"))?;
        let workflow = Self::current_workflow(&guard.board_config);
        let available = transitions_from(&guard.issues[issue_idx].summary_model.status, &workflow);
        let transition = available
            .into_iter()
            .find(|t| t.id == transition_id)
            .ok_or_else(|| format!("Transition {transition_id} not valid for {issue_key}"))?;
        let Some(new_status) = transition.to_status else {
            return Err(format!(
                "Transition {transition_id} not valid for {issue_key}"
            ));
        };

        let source_path = PathBuf::from(&guard.issues[issue_idx].source_path);
        let written =
            write_status_to_markdown_file(&source_path, &new_status).map_err(|e| e.to_string())?;
        if !written {
            return Err(format!(
                "Could not update status in {}. The file status is already set to the target value.",
                source_path.display()
            ));
        }

        let now = now_iso_millis();
        {
            let issue = &mut guard.issues[issue_idx];
            issue.summary_model.status = new_status.clone();
            issue.summary_model.status_category = Some(category_for_status(&new_status, &workflow));
            issue.summary_model.updated = Some(now.clone());
            if new_status == "Done" && issue.summary_model.completed.is_none() {
                issue.summary_model.completed = Some(now.clone());
            }
        }

        let child_seq = guard.issues[issue_idx].summary_model.child_seq;
        let feature_id = guard.issues[issue_idx].feature_id;
        let has_feature_dir = guard.issues[issue_idx].feature_dir_name.is_some();
        let issue_type = guard.issues[issue_idx].summary_model.issue_type.clone();
        let issue_summary = guard.issues[issue_idx].summary_model.summary.clone();

        if let Some(seq) = child_seq
            && has_feature_dir
            && issue_type != "Feature"
            && let Some(parent_idx) = guard
                .issues
                .iter()
                .position(|i| i.summary_model.issue_type == "Feature" && i.feature_id == feature_id)
        {
            let parent_path = PathBuf::from(&guard.issues[parent_idx].source_path);
            let _ = update_feature_story_table(&parent_path, seq, &issue_summary, &new_status);

            if issue_type == "Story" {
                let sibling_statuses: Vec<String> = guard
                    .issues
                    .iter()
                    .filter(|i| i.summary_model.issue_type == "Story" && i.feature_id == feature_id)
                    .map(|i| i.summary_model.status.clone())
                    .collect();
                if let Some(rollup_status) = compute_feature_rollup_status(&sibling_statuses)
                    && rollup_status != guard.issues[parent_idx].summary_model.status
                {
                    let _ = write_status_to_markdown_file(&parent_path, &rollup_status);
                    guard.issues[parent_idx].summary_model.status = rollup_status.clone();
                    guard.issues[parent_idx].summary_model.status_category =
                        Some(category_for_status(&rollup_status, &workflow));
                    guard.issues[parent_idx].summary_model.updated = Some(now);
                }
            }
        }

        Ok(())
    }

    // ── Internal helpers ────────────────────────────────────────────

    fn read_comments_from_file(issue: &LiveIssue) -> Vec<IssueComment> {
        let Ok(content) = read_utf8(Path::new(&issue.source_path)) else {
            return Vec::new();
        };
        extract_comments(&content)
            .into_iter()
            .enumerate()
            .map(|(i, c)| IssueComment {
                id: Some(format!("{}-comment-{}", issue.summary_model.key, i + 1)),
                author: Some(c.author),
                body: c.body,
                created: Some(c.created.clone()),
                updated: Some(c.created),
                raw: None,
            })
            .collect()
    }

    fn ensure_loaded(&self) -> Result<(), String> {
        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        if guard.loaded {
            return Ok(());
        }
        let roots: Vec<String> = self
            .config_store
            .get_folder_roots()
            .into_iter()
            .filter(|r| !r.trim().is_empty())
            .collect();
        if roots.is_empty() {
            return Err(
                "This folder connection has no folders configured. Add at least one plans folder."
                    .to_string(),
            );
        }

        let pk = self.config_store.get_folder_project_key();
        let pn = self.config_store.get_folder_project_name();
        guard.project_key = if pk.is_empty() {
            "LIVE".to_string()
        } else {
            pk
        };
        guard.project_name = if pn.is_empty() {
            "Folder".to_string()
        } else {
            pn
        };
        guard.plans_root_path = None;
        guard.configured_roots = roots.clone();

        self.load_from_disk_locked(&mut guard, Some(&roots))?;
        Self::snapshot_comment_counts(&mut guard);
        Self::setup_watchers(&mut guard);
        guard.loaded = true;
        Ok(())
    }

    fn load_from_disk_locked(
        &self,
        guard: &mut FolderServiceState,
        roots_override: Option<&[String]>,
    ) -> Result<(), String> {
        let roots: Vec<String> = if let Some(ro) = roots_override {
            ro.to_vec()
        } else if !guard.configured_roots.is_empty() {
            guard.configured_roots.clone()
        } else if let Some(ref pr) = guard.plans_root_path {
            vec![pr.clone()]
        } else {
            return Ok(());
        };
        if roots.is_empty() {
            return Ok(());
        }

        // Read board.praxis.json BEFORE parsing markdown plans so custom workflow stages resolve accurately.
        let identified = identify_plan_folder(&roots[0])?;
        guard.board_config = read_board_config_file(Path::new(&identified.plans_root_path));
        let workflow = Self::current_workflow(&guard.board_config);

        let mut parsed = parse_plan_folder(&roots[0], Some(&workflow))?;
        guard.plans_root_path = Some(parsed.plans_root_path.clone());
        guard.features_root_path = Some(parsed.features_root_path.clone());

        if Self::upgrade_existing_files(&parsed) {
            parsed = parse_plan_folder(&roots[0], Some(&workflow))?;
            guard.plans_root_path = Some(parsed.plans_root_path.clone());
            guard.features_root_path = Some(parsed.features_root_path.clone());
        }

        guard.board_config = read_board_config_file(Path::new(&parsed.plans_root_path));
        guard.project_key = self.resolve_key(&guard.board_config);
        guard.project_name = self.resolve_name(&guard.board_config);
        let workflow = Self::current_workflow(&guard.board_config);

        let mut root_parses: Vec<ParsedPlanFolder> = vec![parsed.clone()];
        let mut seen = HashSet::new();
        seen.insert(
            to_stored_folder_path(&parsed.plans_root_path, SupportedPathPlatform::current())
                .to_lowercase(),
        );

        for configured_root in &roots {
            if let Ok(candidates) = discover_plan_folders(configured_root) {
                for candidate in candidates {
                    let key = to_stored_folder_path(
                        &candidate.plans_root_path,
                        SupportedPathPlatform::current(),
                    )
                    .to_lowercase();
                    if !seen.insert(key) {
                        continue;
                    }
                    if let Ok(extra_parsed) =
                        parse_plan_folder(&candidate.plans_root_path, Some(&workflow))
                    {
                        root_parses.push(extra_parsed);
                    }
                }
            }
        }

        let root_configs: Vec<BoardConfigFile> = root_parses
            .iter()
            .enumerate()
            .map(|(idx, rp)| {
                if idx == 0 {
                    guard.board_config.clone()
                } else {
                    read_board_config_file(Path::new(&rp.plans_root_path))
                }
            })
            .collect();

        guard.issues_by_root.clear();
        guard.board_roots.clear();
        let authoritative = self.config_store.prefers_configured_identity();

        for (index, root_parsed) in root_parses.iter().enumerate() {
            let root_key = if authoritative {
                guard.project_key.to_uppercase()
            } else {
                root_configs[index]
                    .project_key
                    .clone()
                    .unwrap_or_else(|| guard.project_key.clone())
                    .to_uppercase()
            };
            let root_project_name = if authoritative {
                guard.project_name.clone()
            } else {
                root_configs[index]
                    .project_name
                    .clone()
                    .unwrap_or_else(|| guard.project_name.clone())
            };

            let built_issues =
                Self::build_issue_model(root_parsed, &root_key, &root_project_name, &workflow);
            guard
                .issues_by_root
                .insert(root_parsed.plans_root_path.clone(), built_issues);

            if index == 0 {
                guard.board_roots.push(FolderBoardRoot {
                    id: format!("folder-{}", root_key.to_lowercase()),
                    name: root_project_name.clone(),
                    root_path: root_parsed.plans_root_path.clone(),
                    features_root_path: root_parsed.features_root_path.clone(),
                    project_key: root_key,
                    project_name: root_project_name,
                });
            } else {
                let fallback_basename = Path::new(&root_parsed.plans_root_path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Folder".to_string());
                let root_name = root_configs[index]
                    .project_name
                    .clone()
                    .unwrap_or(fallback_basename);
                guard.board_roots.push(FolderBoardRoot {
                    id: format!(
                        "folder-{}-{}",
                        root_key.to_lowercase(),
                        hash_root_path(&root_parsed.plans_root_path)
                    ),
                    name: root_name.clone(),
                    root_path: root_parsed.plans_root_path.clone(),
                    features_root_path: root_parsed.features_root_path.clone(),
                    project_key: root_key,
                    project_name: root_name,
                });
            }
        }

        guard.issues = root_parses
            .iter()
            .flat_map(|rp| {
                guard
                    .issues_by_root
                    .get(&rp.plans_root_path)
                    .cloned()
                    .unwrap_or_default()
            })
            .collect();

        Ok(())
    }

    fn upgrade_existing_files(parsed: &ParsedPlanFolder) -> bool {
        let mut any_upgraded = false;
        for f in &parsed.features {
            if upgrade_markdown_file(Path::new(&f.feature_md_path), "Feature").unwrap_or(false) {
                any_upgraded = true;
            }
        }
        for child in &parsed.child_items {
            if upgrade_markdown_file(Path::new(&child.file_path), &child.issue_type)
                .unwrap_or(false)
            {
                any_upgraded = true;
            }
        }
        any_upgraded
    }

    fn build_issue_model(
        parsed: &ParsedPlanFolder,
        project_key: &str,
        project_name: &str,
        workflow: &[ProjectWorkflowStage],
    ) -> Vec<LiveIssue> {
        let mut issues = Vec::with_capacity(parsed.features.len() + parsed.child_items.len());
        let mut feature_dir_name_by_id: HashMap<u32, String> = HashMap::new();

        for f in &parsed.features {
            feature_dir_name_by_id.insert(f.feature_id, f.dir_name.clone());
            let key = stable_feature_key(project_key, f.feature_id);
            let now = now_iso_millis();
            issues.push(LiveIssue {
                summary_model: IssueSummary {
                    id: None,
                    key,
                    summary: f.title.clone(),
                    status: f.plan_status.clone(),
                    status_category: Some(category_for_status(&f.plan_status, workflow)),
                    issue_type: "Feature".to_string(),
                    project_key: project_key.to_string(),
                    project_name: Some(project_name.to_string()),
                    parent_key: None,
                    parent_issue: None,
                    assignee: None,
                    reporter: None,
                    reporter_mention: None,
                    priority: Some(f.priority.clone().unwrap_or_else(|| "Medium".to_string())),
                    severity: None,
                    reported_by: None,
                    complexity: f.complexity.clone(),
                    model: f.model.clone(),
                    created: Some(
                        f.planning_dates
                            .created
                            .clone()
                            .unwrap_or_else(|| now.clone()),
                    ),
                    updated: Some(f.planning_dates.completed.clone().unwrap_or(now)),
                    self_url: None,
                    browse_url: None,
                    description: Some(f.description.clone()),
                    idea_transcript: None,
                    planning_id: f.planning_id.clone(),
                    depends_on: None,
                    branch: None,
                    completed: None,
                    attachments: None,
                    ai_assignment: None,
                    sub_tasks: None,
                    child_seq: None,
                    origin: f.origin,
                    source_path: Some(f.feature_md_path.clone()),
                    raw: None,
                },
                source_path: f.feature_md_path.clone(),
                feature_id: Some(f.feature_id),
                feature_dir_name: Some(f.dir_name.clone()),
            });
        }

        for child in &parsed.child_items {
            let fid = child.feature_id.unwrap_or(0);
            let key = if child.issue_type == "Story" {
                stable_story_key(project_key, fid, child.sequence)
            } else {
                stable_child_key(project_key, &child.issue_type, fid, child.sequence)
            };
            let parent_key = child
                .feature_id
                .map(|id| stable_feature_key(project_key, id));
            let now = now_iso_millis();
            let feature_dir_name = child
                .feature_id
                .and_then(|id| feature_dir_name_by_id.get(&id).cloned());

            issues.push(LiveIssue {
                summary_model: IssueSummary {
                    id: None,
                    key,
                    summary: child.title.clone(),
                    status: child.plan_status.clone(),
                    status_category: Some(category_for_status(&child.plan_status, workflow)),
                    issue_type: child.issue_type.clone(),
                    project_key: project_key.to_string(),
                    project_name: Some(project_name.to_string()),
                    parent_key,
                    parent_issue: None,
                    assignee: None,
                    reporter: None,
                    reporter_mention: None,
                    priority: Some(
                        child
                            .priority
                            .clone()
                            .unwrap_or_else(|| "Medium".to_string()),
                    ),
                    severity: child.severity.clone(),
                    reported_by: child.reported_by.clone(),
                    complexity: child.complexity.clone(),
                    model: child.model.clone(),
                    created: Some(
                        child
                            .planning_dates
                            .created
                            .clone()
                            .unwrap_or_else(|| now.clone()),
                    ),
                    updated: Some(child.planning_dates.completed.clone().unwrap_or(now)),
                    self_url: None,
                    browse_url: None,
                    description: Some(child.description.clone()),
                    idea_transcript: child.idea_transcript.clone(),
                    planning_id: child.planning_id.clone(),
                    depends_on: None,
                    branch: child.branch.clone(),
                    completed: None,
                    attachments: None,
                    ai_assignment: None,
                    sub_tasks: None,
                    child_seq: Some(child.sequence),
                    origin: child.origin,
                    source_path: Some(child.file_path.clone()),
                    raw: None,
                },
                source_path: child.file_path.clone(),
                feature_id: child.feature_id,
                feature_dir_name,
            });
        }

        let dependency_keys = resolve_plan_dependency_keys(parsed, project_key);
        for issue in &mut issues {
            if let Some(keys) = dependency_keys.get(&issue.summary_model.key)
                && !keys.is_empty()
            {
                issue.summary_model.depends_on = Some(keys.clone());
            }
        }

        issues
    }

    fn get_next_feature_id(issues: &[LiveIssue]) -> u32 {
        issues
            .iter()
            .filter(|i| i.summary_model.issue_type == "Feature")
            .filter_map(|i| i.feature_id)
            .max()
            .unwrap_or(0)
            + 1
    }

    fn get_next_child_sequence(
        issues: &[LiveIssue],
        feature_id: u32,
        issue_type: IssueType,
    ) -> u32 {
        issues
            .iter()
            .filter(|i| {
                i.feature_id == Some(feature_id)
                    && i.summary_model.issue_type == issue_type.as_str()
            })
            .filter_map(|i| i.summary_model.child_seq)
            .max()
            .unwrap_or(0)
            + 1
    }

    fn resolve_create_parent(
        issues: &[LiveIssue],
        project_key: &str,
        issue_type: IssueType,
        parent_key: Option<&str>,
    ) -> Result<LiveIssue, String> {
        let rule = get_parent_rule(Some(issue_type.as_str()), BackendMode::Folder);
        let Some(pk) = parent_key.filter(|s| !s.is_empty()) else {
            return Err(format!(
                "{} is required for {} items.",
                rule.default_label,
                issue_type.as_str()
            ));
        };
        let parent_issue = issues
            .iter()
            .find(|i| i.summary_model.key == pk)
            .ok_or_else(|| format!("{} {pk} was not found.", rule.default_label))?;
        if parent_issue.summary_model.project_key != project_key {
            return Err(format!(
                "{} {pk} must be in the same project.",
                rule.default_label
            ));
        }
        if !is_allowed_parent_type(
            Some(&parent_issue.summary_model.issue_type),
            Some(issue_type.as_str()),
            BackendMode::Folder,
        ) {
            return Err(build_parent_validation_message(
                Some(issue_type.as_str()),
                BackendMode::Folder,
                Some(&parent_issue.summary_model.issue_type),
            ));
        }
        if parent_issue.feature_dir_name.is_none() {
            return Err(format!(
                "Feature {} is missing its plans directory.",
                parent_issue.summary_model.key
            ));
        }
        Ok(parent_issue.clone())
    }

    fn snapshot_comment_counts(guard: &mut FolderServiceState) {
        for issue in &guard.issues {
            if let Ok(content) = read_utf8(Path::new(&issue.source_path)) {
                let count = extract_comments(&content).len();
                guard
                    .comment_count_snapshot
                    .insert(issue.summary_model.key.clone(), count);
            }
        }
    }

    fn setup_watchers(guard: &mut FolderServiceState) {
        if !guard.watchers.is_empty() || guard.board_roots.is_empty() {
            return;
        }
        for root in &guard.board_roots {
            let watcher = watch_folder(Path::new(&root.root_path), move |abs_path| {
                let content = folder_read_file(&abs_path).ok();
                let _ = is_own_folder_write(&abs_path, content.as_deref());
            });
            guard.watchers.push(watcher);
        }
    }
}

impl Drop for FolderService {
    fn drop(&mut self) {
        self.dispose();
    }
}

#[async_trait]
impl IssueTrackerService for FolderService {
    fn mode(&self) -> BackendMode {
        BackendMode::Folder
    }

    fn get_default_page_size(&self) -> usize {
        self.get_default_page_size()
    }

    async fn reset(&self) -> TrackerResult<()> {
        self.reset()
    }

    async fn check_connection(&self) -> TrackerResult<ConnectionCheck> {
        Ok(self.check_connection())
    }

    async fn get_projects(&self, _force_refresh: bool) -> TrackerResult<Vec<Project>> {
        self.get_projects()
    }

    async fn get_issues(
        &self,
        filters: &IssueFilters,
        start_at: usize,
        page_size: usize,
    ) -> TrackerResult<PagedIssues> {
        self.get_issues(filters, start_at, page_size)
    }

    async fn get_filter_metadata(&self, filters: &IssueFilters) -> TrackerResult<FilterMetadata> {
        self.get_filter_metadata(filters)
    }

    async fn get_parent_items(
        &self,
        filters: &IssueFilters,
        search_text: Option<&str>,
        options: Option<&ParentItemQueryOptions>,
    ) -> TrackerResult<Vec<IssueSummary>> {
        self.get_parent_items(filters, search_text, options)
    }

    async fn supports_boards(&self) -> TrackerResult<bool> {
        Ok(true)
    }

    async fn get_boards(&self, filters: &BoardFilters) -> TrackerResult<Vec<Board>> {
        self.get_boards(filters)
    }

    async fn get_board_details(&self, board: &Board) -> TrackerResult<BoardDetails> {
        self.get_board_details(board)
    }

    async fn create_board(&self, _input: &CreateBoardInput) -> TrackerResult<Board> {
        Err("Folder mode does not support creating boards.".to_string())
    }

    async fn update_board(
        &self,
        _board_id: &str,
        _input: &UpdateBoardInput,
    ) -> TrackerResult<Board> {
        Err("Folder mode does not support updating boards.".to_string())
    }

    async fn delete_board(&self, _board_id: &str) -> TrackerResult<()> {
        Err("Folder mode does not support deleting boards.".to_string())
    }

    async fn get_issue(&self, issue_key: &str) -> TrackerResult<IssueDetails> {
        self.get_issue(issue_key)
    }

    async fn create_issue(&self, input: &CreateIssueInput) -> TrackerResult<IssueDetails> {
        self.create_issue(input)
    }

    async fn update_issue(
        &self,
        issue_key: &str,
        input: &UpdateIssueInput,
    ) -> TrackerResult<IssueDetails> {
        self.update_issue(issue_key, input)
    }

    async fn delete_issue(&self, _issue_key: &str) -> TrackerResult<()> {
        Err(
            "Folder mode does not support deleting issues. Remove the markdown files directly."
                .to_string(),
        )
    }

    async fn add_comment(&self, issue_key: &str, body: &str) -> TrackerResult<()> {
        self.add_comment(issue_key, body)
    }

    async fn attach_file(
        &self,
        _issue_key: &str,
        _file_path: &str,
        _file_name: Option<&str>,
    ) -> TrackerResult<()> {
        Err("Folder mode does not support attachments.".to_string())
    }

    async fn download_attachment(
        &self,
        _issue_key: &str,
        _attachment: &IssueAttachment,
        _target_file_path: &str,
    ) -> TrackerResult<()> {
        Err("Folder mode does not support attachment downloads.".to_string())
    }

    async fn get_transitions(&self, issue_key: &str) -> TrackerResult<Vec<WorkflowTransition>> {
        self.get_transitions(issue_key)
    }

    async fn transition_issue(&self, issue_key: &str, transition_id: &str) -> TrackerResult<()> {
        self.transition_issue(issue_key, transition_id)
    }

    async fn get_browse_url(&self, issue: &IssueSummary) -> TrackerResult<Option<String>> {
        let guard = self.state.lock().map_err(|e| e.to_string())?;
        let url = guard
            .issues
            .iter()
            .find(|i| i.summary_model.key == issue.key)
            .map(|i| i.source_path.clone());
        Ok(url)
    }

    async fn get_self_assignee_label(&self) -> TrackerResult<Option<String>> {
        Ok(None)
    }

    fn dispose(&self) {
        self.dispose();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        // Parallel test threads can read the same timestamp; the counter keeps paths distinct.
        static NEXT_TEMP: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sequence = NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("{prefix}-{nanos}-{sequence}"));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[test]
    fn loads_board_config_workflow_before_parsing_and_supports_crud() {
        let root = temp_dir("praxis-folder-service");
        let features_dir = root.join("features");
        std::fs::create_dir_all(&features_dir).expect("mkdir features");

        // Write a custom workflow to board.praxis.json first
        let custom_wf = vec![
            ProjectWorkflowStage {
                id: "s1".to_string(),
                name: "Backlog".to_string(),
                category: Some(WorkflowStageCategory::Todo),
            },
            ProjectWorkflowStage {
                id: "s2".to_string(),
                name: "Architecture".to_string(),
                category: Some(WorkflowStageCategory::Indeterminate),
            },
            ProjectWorkflowStage {
                id: "s3".to_string(),
                name: "Done".to_string(),
                category: Some(WorkflowStageCategory::Done),
            },
        ];
        write_board_config_file(
            &root,
            &BoardConfigFile {
                project_key: Some("ARCH".to_string()),
                project_name: Some("Arch Board".to_string()),
                allow_issue_creation: Some(true),
                workflow: Some(custom_wf),
            },
        )
        .expect("write board.praxis.json");

        // Write a feature whose status is "Architecture" — if board.praxis.json were read
        // after parsing, "Architecture" would fall back to "Backlog"!
        let f1_dir = features_dir.join("feature-01-design");
        std::fs::create_dir_all(&f1_dir).expect("mkdir f1");
        std::fs::write(
            f1_dir.join("feature.md"),
            "# Core Design\n\n**Status:** Architecture\n**Type:** Feature\n\n## Description\n\nInitial design.\n",
        )
        .expect("write feature.md");

        let service = FolderService::from_static(StaticFolderConfig {
            folder_roots: vec![root.to_string_lossy().to_string()],
            project_key: "FALLBACK".to_string(),
            project_name: "Fallback".to_string(),
            allow_issue_creation: false,
            ..StaticFolderConfig::default()
        });

        let check = service.check_connection();
        assert_eq!(check.status, ConnectionCheckStatus::Ok);
        assert!(check.message.contains("issue creation enabled"));

        let f1 = service.get_issue("ARCH-F01").expect("get ARCH-F01");
        assert_eq!(f1.summary.status, "Architecture");
        assert_eq!(f1.summary.status_category.as_deref(), Some("indeterminate"));

        // Create a Story under ARCH-F01
        let created_story = service
            .create_issue(&CreateIssueInput {
                project_key: "ARCH".to_string(),
                issue_type: "Story".to_string(),
                summary: "Implement parser".to_string(),
                description: Some("Story details.".to_string()),
                parent_key: Some("ARCH-F01".to_string()),
                priority: Some("High".to_string()),
                ..CreateIssueInput::default()
            })
            .expect("create story");
        assert_eq!(created_story.summary.key, "ARCH-S01-1");
        assert_eq!(created_story.summary.priority.as_deref(), Some("High"));

        // Transition story to Done and verify rollup
        let transitions = service
            .get_transitions("ARCH-S01-1")
            .expect("get transitions");
        let to_done = transitions
            .iter()
            .find(|t| t.to_status.as_deref() == Some("Done"))
            .expect("Done transition");
        service
            .transition_issue("ARCH-S01-1", &to_done.id)
            .expect("transition to Done");

        let updated_f1 = service.get_issue("ARCH-F01").expect("get updated ARCH-F01");
        assert_eq!(updated_f1.summary.status, "Done");

        // Add comment and update summary
        service
            .add_comment("ARCH-S01-1", "Verified in unit test.")
            .expect("add comment");
        let edited = service
            .update_issue(
                "ARCH-S01-1",
                &UpdateIssueInput {
                    summary: Some("Implement Rust parser".to_string()),
                    ..UpdateIssueInput::default()
                },
            )
            .expect("update issue");
        assert_eq!(edited.summary.summary, "Implement Rust parser");
        assert_eq!(edited.comments.as_ref().map(Vec::len), Some(1));

        service.dispose();
        let _ = std::fs::remove_dir_all(&root);
    }
}
