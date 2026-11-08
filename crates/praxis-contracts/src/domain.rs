//! Foundational domain types shared across Praxis backend crates (`praxis-core`,
//! `praxis-trackers`, `praxis-workflows`, `praxis-ai`, `praxis-mobile`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::{Type, TypeCollection};

use crate::ipc::TsUnknown;

/// Transport mechanism for MCP / external connections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionType {
    Stdio,
    Http,
}

/// How a board's issues are stored and reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum BackendMode {
    Jiracloud,
    Demo,
    Github,
    Gitlab,
    Folder,
    App,
    /// Legacy saved record mode migrated to `app` or `folder` on startup.
    Project,
}

/// Filter scope for issue assignee filtering.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AssigneeMode {
    Me,
    #[default]
    All,
}

/// Issue grouping mode on board/list views.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GroupingMode {
    Project,
    Status,
    #[default]
    None,
}

/// Built-in AI provider identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub enum BuiltInAiProvider {
    #[serde(rename = "vercel-gateway")]
    VercelGateway,
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "z-ai")]
    ZAi,
    #[serde(rename = "claude-code-cli")]
    ClaudeCodeCli,
    #[serde(rename = "codex-cli")]
    CodexCli,
    #[serde(rename = "copilot-cli")]
    CopilotCli,
    #[serde(rename = "antigravity-cli")]
    AntigravityCli,
    #[serde(rename = "cursor-cli")]
    CursorCli,
}

/// How a ticket entered the board (`capture` = Quick Capture).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IssueOrigin {
    Capture,
}

/// Tracker project summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub id: Option<String>,
    pub key: String,
    pub name: String,
}

/// Workflow stage category used by `resolveStatus` to map freeform status text to board columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowStageCategory {
    Todo,
    Indeterminate,
    Done,
}

/// One stage in a project's workflow (`{ id, name, category }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkflowStage {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = WorkflowStageCategory)]
    pub category: Option<WorkflowStageCategory>,
}

/// Available status transition on an issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTransition {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub to_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = TsUnknown)]
    pub raw: Option<serde_json::Value>,
}

/// Comment attached to an issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub author: Option<String>,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub updated: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = TsUnknown)]
    pub raw: Option<serde_json::Value>,
}

/// File or media attachment metadata on an issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueAttachment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub id: Option<String>,
    pub file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = u64)]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub content_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub thumbnail_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = TsUnknown)]
    pub raw: Option<serde_json::Value>,
}

/// Reference to a parent issue (Feature / Epic / Story).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParentIssueReference {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub issue_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub description: Option<String>,
}

/// Linked issue reference (blocks / relates to / depends on).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkedIssueReference {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub issue_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub status: Option<String>,
    pub relationship: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub browse_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = TsUnknown)]
    pub raw: Option<serde_json::Value>,
}

/// Summary of a child sub-task under an issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubTaskSummary {
    pub key: String,
    pub summary: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub status_category: Option<String>,
    pub issue_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub assignee: Option<String>,
}

/// Query options when listing candidate parent items.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParentItemQueryOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub child_issue_type: Option<String>,
}

/// Input for updating a board's metadata.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBoardInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub jql: Option<String>,
}

/// Input for creating a new board.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateBoardInput {
    pub name: String,
    pub project_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub live_folder_path: Option<String>,
}

/// Issue filter criteria applied to board/list queries.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct IssueFilters {
    pub project_keys: Vec<String>,
    pub statuses: Vec<String>,
    pub issue_types: Vec<String>,
    pub search_text: String,
    pub assignee_mode: AssigneeMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub parent_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub board_id: Option<String>,
    pub grouping: GroupingMode,
}

/// Board filter criteria applied to board discovery queries.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardFilters {
    pub project_keys: Vec<String>,
    pub types: Vec<String>,
    pub search_text: String,
}

/// Reference to a board the user has explicitly chosen to track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrackedBoard {
    pub connection_id: String,
    pub board_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub display_name: Option<String>,
}

/// Minimal `{ connectionId, boardId }` reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrackedBoardRef {
    pub connection_id: String,
    pub board_id: String,
}

/// Health status of a backend connection check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionCheckStatus {
    Ok,
    Warning,
    Error,
}

/// Result of running a connection's health check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCheck {
    pub status: ConnectionCheckStatus,
    pub message: String,
    pub tool_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = u32)]
    pub project_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub server_name: Option<String>,
}

/// Distinct statuses and issue types available under a filter scope.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FilterMetadata {
    pub statuses: Vec<String>,
    pub issue_types: Vec<String>,
}

/// Horizontal swimlane grouping mode on a board.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SwimLaneGroupBy {
    None,
    Assignee,
    Epic,
}

/// Board panel layout mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BoardViewMode {
    Board,
    List,
}

/// Per-board column and view layout preferences.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardColumnPreferences {
    pub workflow_statuses: Vec<String>,
    pub ordered_statuses: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub project_pill_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = SwimLaneGroupBy)]
    pub swim_lane_group_by: Option<SwimLaneGroupBy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub issue_filter_assignee: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub issue_filter_epic_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Vec<String>)]
    pub issue_filter_statuses: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = HashMap<String, String>)]
    pub status_colors: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = HashMap<String, String>)]
    pub issue_type_colors: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = BoardViewMode)]
    pub view_mode: Option<BoardViewMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Vec<String>)]
    pub list_group_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = u32)]
    pub max_age_weeks: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = HashMap<String, Vec<String>>)]
    pub issue_order: Option<HashMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub plain_surface: Option<bool>,
}

/// MCP tool descriptor metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub read_only_hint: Option<bool>,
}

/// Restriction on issue creation for a specific board (e.g. secondary plans root).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardIssueCreationRestriction {
    pub allowed: bool,
    pub reason: String,
}

/// Tracker board metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub board_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub created_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub project_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub location_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub availability: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub availability_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = BoardIssueCreationRestriction)]
    pub issue_creation: Option<BoardIssueCreationRestriction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = TsUnknown)]
    pub raw: Option<serde_json::Value>,
}

/// Summary representation of an issue on a board or list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub id: Option<String>,
    pub key: String,
    pub summary: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub status_category: Option<String>,
    pub issue_type: String,
    pub project_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub parent_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = ParentIssueReference)]
    pub parent_issue: Option<ParentIssueReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub assignee: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub reporter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub reporter_mention: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub severity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub reported_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub complexity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub updated: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub self_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub browse_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub idea_transcript: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub planning_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Vec<String>)]
    pub depends_on: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub completed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Vec<IssueAttachment>)]
    pub attachments: Option<Vec<IssueAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = TsUnknown)]
    pub ai_assignment: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Vec<SubTaskSummary>)]
    pub sub_tasks: Option<Vec<SubTaskSummary>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = u32)]
    pub child_seq: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = IssueOrigin)]
    pub origin: Option<IssueOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = TsUnknown)]
    pub raw: Option<serde_json::Value>,
}

/// Full details of a single issue including transitions, comments, and linked issues.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetails {
    #[serde(flatten)]
    pub summary: IssueSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Vec<WorkflowTransition>)]
    pub transitions: Option<Vec<WorkflowTransition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Vec<IssueComment>)]
    pub comments: Option<Vec<IssueComment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Vec<LinkedIssueReference>)]
    pub linked_issues: Option<Vec<LinkedIssueReference>>,
}

/// Input payload for creating a new issue.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateIssueInput {
    pub project_key: String,
    pub issue_type: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub idea_transcript: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub parent_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub board_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub new_parent_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub severity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = HashMap<String, String>)]
    pub sections: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = IssueOrigin)]
    pub origin: Option<IssueOrigin>,
}

fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Input payload for updating an existing issue.
///
/// Fields with `Option<Option<String>>` distinguish absent (`None`) from explicit `null` (`Some(None)`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateIssueInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub idea_transcript: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_double_option"
    )]
    #[specta(type = Option<String>)]
    pub parent_key: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_double_option"
    )]
    #[specta(type = Option<String>)]
    pub assignee: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub severity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub reported_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub issue_type: Option<String>,
}

/// Paginated list of issues returned by `getIssues`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PagedIssues {
    pub issues: Vec<IssueSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = u32)]
    pub total: Option<u32>,
    pub has_more: bool,
}

/// One column on a Kanban board.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardColumn {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub status_category: Option<String>,
    pub issues: Vec<IssueSummary>,
}

/// Full board details including columns, issues, and canonical column status order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardDetails {
    pub board: Board,
    pub columns: Vec<BoardColumn>,
    pub issues: Vec<IssueSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Vec<String>)]
    pub column_status_order: Option<Vec<String>>,
}

/// Registers all foundational domain types into a [`TypeCollection`].
pub fn register_domain_types(types: &mut TypeCollection) {
    types
        .register::<ConnectionType>()
        .register::<BackendMode>()
        .register::<AssigneeMode>()
        .register::<GroupingMode>()
        .register::<BuiltInAiProvider>()
        .register::<IssueOrigin>()
        .register::<Project>()
        .register::<WorkflowStageCategory>()
        .register::<ProjectWorkflowStage>()
        .register::<WorkflowTransition>()
        .register::<IssueComment>()
        .register::<IssueAttachment>()
        .register::<ParentIssueReference>()
        .register::<LinkedIssueReference>()
        .register::<SubTaskSummary>()
        .register::<ParentItemQueryOptions>()
        .register::<UpdateBoardInput>()
        .register::<CreateBoardInput>()
        .register::<IssueFilters>()
        .register::<BoardFilters>()
        .register::<TrackedBoard>()
        .register::<TrackedBoardRef>()
        .register::<ConnectionCheckStatus>()
        .register::<ConnectionCheck>()
        .register::<FilterMetadata>()
        .register::<SwimLaneGroupBy>()
        .register::<BoardViewMode>()
        .register::<BoardColumnPreferences>()
        .register::<ToolDescriptor>()
        .register::<BoardIssueCreationRestriction>()
        .register::<Board>()
        .register::<IssueSummary>()
        .register::<IssueDetails>()
        .register::<CreateIssueInput>()
        .register::<UpdateIssueInput>()
        .register::<PagedIssues>()
        .register::<BoardColumn>()
        .register::<BoardDetails>();
}
