//! IPC contract types shared between the Rust host and the TypeScript renderer/main bridge.
//!
//! All types in this module are registered in [`register_ipc_types`] and exported into
//! `packages/core/src/host/ipcContracts.ts` between `// praxis-contracts:begin` and
//! `// praxis-contracts:end` markers by `cargo run -p praxis-contracts --bin export-types`.

use serde::{Deserialize, Serialize};
use specta::{Generics, Type, TypeCollection, datatype::DataType};

/// Marker type for `serde_json::Value` fields that should export as TypeScript `unknown`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TsUnknown(pub serde_json::Value);

impl Type for TsUnknown {
    fn inline(_type_map: &mut TypeCollection, _generics: Generics) -> DataType {
        DataType::Unknown
    }
}

/// Health and version metadata returned by the Rust host bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RustHostStatus {
    pub crate_version: String,
    pub protocol_version: u32,
}

impl Default for RustHostStatus {
    fn default() -> Self {
        Self {
            crate_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: 1,
        }
    }
}

/// Envelope for a request sent over the Rust host RPC bridge (`window.praxis` / Electron / E2E WS).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RustRpcRequest {
    pub id: String,
    pub channel: String,
    #[serde(default)]
    #[specta(type = Vec<TsUnknown>)]
    pub args: Vec<serde_json::Value>,
}

/// Structured error returned when a Rust host RPC call fails.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RustRpcError {
    pub code: String,
    pub message: String,
}

/// Envelope for a response returned by the Rust host RPC bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RustRpcResponse {
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = TsUnknown)]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = RustRpcError)]
    pub error: Option<RustRpcError>,
}

/// Server-pushed event envelope emitted by the Rust host to subscribed listeners.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RustEventEnvelope {
    pub channel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = TsUnknown)]
    pub payload: Option<serde_json::Value>,
}

/// Destination opened by a desktop task notification.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotificationTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub session_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub conversation: Option<bool>,
}

/// CSS pixel rectangle used to position native child browser views over renderer placeholders.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Live state of the in-app AI browser, pushed on `browser:didNavigate`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationState {
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub loading: bool,
}

/// Result of a page-level browser action returned to the renderer toolbar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageResult {
    pub url: String,
    pub title: String,
    pub text: String,
}

/// Update state as the host process sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateStatus {
    #[serde(rename_all = "camelCase")]
    Unsupported { reason: String },
    #[serde(rename_all = "camelCase")]
    Checking,
    #[serde(rename_all = "camelCase")]
    Current { version: String },
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        can_install: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(type = String)]
        release_url: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Downloading { version: String, percent: f64 },
    #[serde(rename_all = "camelCase")]
    Ready { version: String },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

/// Owner account kind for the add-on marketplace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MarketplaceOwnerType {
    User,
    Org,
}

/// Marketplace configuration state, safe to show in the renderer (no token value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceStatus {
    /// `enabled`, an `owner`, and a stored token are all present.
    pub ready: bool,
    pub enabled: bool,
    pub owner: String,
    pub owner_type: MarketplaceOwnerType,
    pub package_name_prefix: String,
    pub api_base_url: String,
    pub registry_base_url: String,
    pub check_on_launch: bool,
    pub has_token: bool,
}

/// Config the renderer may change — everything in [`MarketplaceStatus`] bar the token.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceConfigPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = MarketplaceOwnerType)]
    pub owner_type: Option<MarketplaceOwnerType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub package_name_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub api_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub registry_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub check_on_launch: Option<bool>,
}

/// Options when installing an add-on from the marketplace.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceInstallOptions {
    /// Pin a published version instead of `latest`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub version: Option<String>,
    /// Grant a non-declarative (`agent`, `skill`) add-on execution trust as part of installing it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub trust: Option<bool>,
}

/// Speaker role for a chat message in an issue analysis or workflow assistant conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiAnalysisRole {
    User,
    Assistant,
}

/// One chat turn in the per-issue analysis conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiAnalysisMessage {
    pub role: AiAnalysisRole,
    pub text: String,
    pub created_at: String,
}

/// Where the effective AI gateway API key came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiKeySource {
    Secret,
    Env,
    None,
}

/// Commit summary entry inside [`WorkflowRunWorkInfo`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunCommitSummary {
    pub sha: String,
    pub subject: String,
}

/// What a workflow run has left in the repository (see `inspectRunWork`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunWorkInfo {
    /// The run's branch, when it exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub branch: Option<String>,
    /// Commits on it that exist on no other branch — what deleting the branch would lose.
    pub commit_count: u32,
    /// Newest first, at most five.
    pub commits: Vec<WorkflowRunCommitSummary>,
    /// The run's live worktree, when it still exists on disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub worktree_path: Option<String>,
    /// Files with uncommitted changes in that worktree.
    pub uncommitted_files: u32,
    /// Anything a person would want warning about: commits only on the branch, or uncommitted files.
    pub has_work: bool,
}

/// User-supplied edits to a session's living handover brief.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiHandoverBriefEdits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub progress: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub changes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub decisions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub risks: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub open_questions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub next_steps: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub user_notes: Option<String>,
}

/// Model selection payload for updating an idle session's model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionModelInput {
    pub model: String,
}

/// `data` of an `owner-*` code-intelligence response.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeIntelligenceOwnerStatus {
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = u32)]
    pub process_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub build: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub started_utc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub current_build: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub outdated: Option<bool>,
    /// Whether the data directory holds an index, i.e. something was ever registered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub has_index: Option<bool>,
}

/// Status of the pinned local semantic embedding model (`BAAI/bge-small-en-v1.5`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SemanticModelStatus {
    pub installed: bool,
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = u64)]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub downloading: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = f64)]
    pub progress_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub error: Option<String>,
    /// Files from an earlier pinned model are on disk; downloading replaces them with the current one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub update_available: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub architecture: Option<String>,
}

/// Download progress event for the pinned semantic embedding model.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SemanticModelProgressEvent {
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub percent: f64,
}

/// Summary of the next armed schedule shown in a window close confirmation dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowCloseNextSchedule {
    pub name: String,
    pub scheduled_start_at: String,
    pub timezone: String,
}

/// What closing or quitting would interrupt or prevent, when the renderer is asked to confirm.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowCloseRequest {
    pub running_session_count: u32,
    /// The next armed schedule, which only starts while Praxis is open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = WindowCloseNextSchedule)]
    pub next_schedule: Option<WindowCloseNextSchedule>,
}

/// A workflow a scheduled run can start each ticket with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledWorkflowChoice {
    pub workflow_id: String,
    pub name: String,
    pub trigger: String,
}

/// Message in the workflow designer's constrained assistant conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAssistantMessage {
    pub role: AiAnalysisRole,
    pub text: String,
}

/// Input payload for creating or reusing an integrated terminal session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub cwd: Option<String>,
    pub cols: u32,
    pub rows: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub profile_id: Option<String>,
    /// Reuse an active matching terminal during automatic panel initialisation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = bool)]
    pub reuse_existing: Option<bool>,
}

/// Available shell profile for integrated terminal sessions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub id: String,
    pub name: String,
    pub shell: String,
    pub is_default: bool,
}

/// Execution status of a tracked shell command in an integrated terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TerminalCommandStatus {
    Running,
    Success,
    Failed,
}

/// Tracked command record captured from an integrated terminal session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandRecord {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = i32)]
    pub exit_code: Option<i32>,
    pub output: String,
    pub status: TerminalCommandStatus,
}

/// Metadata and state of an integrated terminal session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub shell: String,
    pub profile_id: String,
    pub profile_name: String,
    pub has_context: bool,
    pub exited: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = TerminalCommandRecord)]
    pub last_command: Option<TerminalCommandRecord>,
}

/// Event emitted when a terminal command starts or finishes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandEvent {
    pub session_id: String,
    pub command: TerminalCommandRecord,
}

/// Snapshot of recent ANSI-free terminal output attached to an AI session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalContext {
    pub session_id: String,
    pub cwd: String,
    /// ANSI-free recent output, capped main-side before it crosses IPC.
    pub output: String,
    pub captured_at: String,
}

/// Raw PTY output chunk streamed to the terminal UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub data: String,
}

/// Event emitted when a terminal process exits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = i32)]
    pub signal: Option<i32>,
}

/// Event emitted when a terminal session's captured-context availability changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalContextAvailabilityEvent {
    pub session_id: String,
    pub terminal_has_context: bool,
}

/// How a dropped issue relates to the main dropped issue (drives connector direction).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum TaskDesignerRelatedIssueRelation {
    #[serde(rename = "dependsOn")]
    DependsOn,
    #[serde(rename = "subTask")]
    SubTask,
}

/// Directed relationship between two issues resolved when dropping onto Task Designer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskDesignerResolvedIssueRelation {
    pub relation: TaskDesignerRelatedIssueRelation,
    pub source_issue_key: String,
    pub target_issue_key: String,
}

/// Where the generated master-plan artifacts landed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskDesignerMasterPlanResult {
    pub output_path: String,
    pub generated_features_path: String,
    pub generated_feature_count: u32,
    pub generated_story_count: u32,
    pub fingerprint: String,
}

/// What a gadget or the dock knows about an artifact when it is saved.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveArtifactDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = String)]
    pub media_type: Option<String>,
}

/// Registers all IPC contract types into a [`TypeCollection`] for deterministic TypeScript export.
pub fn register_ipc_types(types: &mut TypeCollection) {
    types
        .register::<RustHostStatus>()
        .register::<RustRpcRequest>()
        .register::<RustRpcError>()
        .register::<RustRpcResponse>()
        .register::<RustEventEnvelope>()
        .register::<TaskNotificationTarget>()
        .register::<BrowserBounds>()
        .register::<BrowserNavigationState>()
        .register::<BrowserPageResult>()
        .register::<UpdateStatus>()
        .register::<MarketplaceOwnerType>()
        .register::<MarketplaceStatus>()
        .register::<MarketplaceConfigPatch>()
        .register::<MarketplaceInstallOptions>()
        .register::<AiAnalysisRole>()
        .register::<AiAnalysisMessage>()
        .register::<AiKeySource>()
        .register::<WorkflowRunCommitSummary>()
        .register::<WorkflowRunWorkInfo>()
        .register::<AiHandoverBriefEdits>()
        .register::<AiSessionModelInput>()
        .register::<CodeIntelligenceOwnerStatus>()
        .register::<SemanticModelStatus>()
        .register::<SemanticModelProgressEvent>()
        .register::<WindowCloseNextSchedule>()
        .register::<WindowCloseRequest>()
        .register::<ScheduledWorkflowChoice>()
        .register::<WorkflowAssistantMessage>()
        .register::<CreateTerminalInput>()
        .register::<TerminalProfile>()
        .register::<TerminalCommandStatus>()
        .register::<TerminalCommandRecord>()
        .register::<TerminalSessionInfo>()
        .register::<TerminalCommandEvent>()
        .register::<TerminalContext>()
        .register::<TerminalOutputEvent>()
        .register::<TerminalExitEvent>()
        .register::<TerminalContextAvailabilityEvent>()
        .register::<TaskDesignerRelatedIssueRelation>()
        .register::<TaskDesignerResolvedIssueRelation>()
        .register::<TaskDesignerMasterPlanResult>()
        .register::<SaveArtifactDetails>();
}
