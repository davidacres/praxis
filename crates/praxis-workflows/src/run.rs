//! Durable workflow run state and event log (`workflowRun.ts` port, FX-BE-019).
//!
//! A run is a reduced value: every transition is a pure `(run, command) → run` step that
//! appends to an event log. Two properties are load-bearing for recovery:
//!
//! - **Idempotent.** Re-applying a command the run already absorbed is a no-op — the
//!   transition returns `None` — so restart recovery can replay without double-counting.
//! - **Observable.** The event log is the whole history.
//!
//! A run embeds the definition it started against, so editing a workflow never rewrites a
//! run already in flight.

use std::collections::{BTreeMap, HashSet, VecDeque};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::edges::{
    PendingLoopKind, RunParameters, countable_findings, dag_edges, describe_findings_predicate,
    loop_budget, loop_statuses, pending_loop, severity_rank,
};
use crate::providers::{custom_provider_lacks_tools, provider_display_name};
use crate::stage_session::find_snapshot;
use crate::types::{
    AgentToolMode, CheckFinding, CheckFindings, ParameterValue, WORKFLOW_MAX_LOOP_ITERATIONS,
    WORKFLOW_SCHEMA_VERSION, WorkflowArtifactKind, WorkflowArtifactRef, WorkflowBoardReference,
    WorkflowDefinition, WorkflowEdgeOutcome, WorkflowGateDecision, WorkflowNode,
    WorkflowNodeOutcome,
};

/// How a run's stage sessions handle their own tool-permission requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowPermissionMode {
    Ask,
    Auto,
}

/// What a run does about uncommitted changes in the checkout it starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowUncommittedChanges {
    Include,
    Omit,
}

/// Why a stage attempt stopped without a verdict, so the run waits instead of failing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowPauseReason {
    ProviderLimit,
    Environment,
}

/// What a run does when a stage's AI runs out of budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowProviderLimitPolicy {
    Ask,
    Switch,
    Stop,
}

/// A run's overall status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowRunStatus {
    Running,
    AwaitingApproval,
    Succeeded,
    Failed,
    Cancelled,
}

/// Kinds of run event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowRunEventKind {
    RunStarted,
    RunSucceeded,
    RunFailed,
    RunCancelled,
    NodeStarted,
    NodeSucceeded,
    NodeFailed,
    NodeTimedOut,
    NodeSkipped,
    NodeCancelled,
    NodeRetried,
    NodeReworked,
    RevisionStarted,
    NodeInterrupted,
    NodeProgress,
    NodeProviderSwitched,
    ArtifactProduced,
    GateDecided,
    LoopTaken,
    LoopDecided,
    LoopRestored,
}

/// One entry in a run's event log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunEvent {
    /// `<runId>-<sequence>`; the sequence is the log length at append time.
    pub id: String,
    pub at: String,
    pub kind: WorkflowRunEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<usize>,
    pub message: String,
}

/// A finding a new revision was started to fix, and the stage that raised it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RevisionFindingItem {
    pub stage: String,
    pub finding: CheckFinding,
}

/// What a person started the current revision to fix.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRevisionFindings {
    pub at: String,
    pub node_id: String,
    pub items: Vec<RevisionFindingItem>,
}

/// Whether an `independentOf` stage's attempt ran apart from its author (FX-BE-164).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageIndependence {
    pub independent: bool,
    pub reason: String,
}

/// One attempt at a node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeAttempt {
    /// 1-based.
    pub attempt: usize,
    pub outcome: WorkflowNodeOutcome,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<WorkflowPauseReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub independence: Option<StageIndependence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_files: Option<Vec<String>>,
}

/// How one map item went (FX-BE-165).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MapItemOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Deferred,
}

/// One map item's state, latest attempt's view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMapItemState {
    pub key: String,
    pub label: String,
    pub outcome: MapItemOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub findings: Option<CheckFindings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<WorkflowPauseReason>,
}

/// One node's live state inside a run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeState {
    pub node_id: String,
    pub outcome: WorkflowNodeOutcome,
    pub attempts: Vec<WorkflowNodeAttempt>,
    pub artifacts: Vec<WorkflowArtifactRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assessed_snapshot_ref: Option<String>,
    /// A sub-phase of the current attempt; cleared when an attempt starts or settles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub findings: Option<CheckFindings>,
    /// Attempts before this index belong to earlier loop iterations or revisions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_base: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_items: Option<Vec<WorkflowMapItemState>>,
}

impl WorkflowNodeState {
    /// A fresh, never-run node.
    #[must_use]
    pub fn pending(node_id: &str) -> Self {
        Self {
            node_id: node_id.to_string(),
            outcome: WorkflowNodeOutcome::Pending,
            attempts: Vec::new(),
            artifacts: Vec::new(),
            snapshot_ref: None,
            assessed_snapshot_ref: None,
            phase: None,
            findings: None,
            revision_base: None,
            map_items: None,
        }
    }
}

/// Which outcome fired a loop edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoopSourceOutcome {
    Succeeded,
    Failed,
}

/// One time a loop edge was taken.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLoopIteration {
    pub edge_id: String,
    /// 1-based.
    pub iteration: u32,
    pub at: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub outcome: LoopSourceOutcome,
    pub findings: Vec<CheckFinding>,
    pub finding_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<BTreeMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored_to: Option<String>,
}

/// A person's answer to a loop whose budget ran out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoopDecisionKind {
    Accept,
    Grant,
    Stop,
}

/// A recorded loop decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLoopDecision {
    pub edge_id: String,
    pub at: String,
    pub actor: String,
    pub decision: LoopDecisionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_iterations: Option<u32>,
    /// The source attempt the decision was about.
    pub source_attempt: usize,
}

/// A keep-best restore the host has yet to apply to the worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPendingRestore {
    #[serde(rename = "ref")]
    pub reference: String,
    pub edge_id: String,
    pub iteration: u32,
    pub reason: String,
    pub at: String,
}

/// An explicit plan handed off from Task Designer into a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPlanInput {
    pub source: String,
    pub board_id: String,
    pub output_path: String,
    pub generated_features_path: String,
    pub fingerprint: String,
    pub generated_feature_count: u32,
    pub generated_story_count: u32,
}

/// A workflow run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub schema_version: u32,
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_version: u32,
    pub project_id: String,
    pub status: WorkflowRunStatus,
    pub definition: WorkflowDefinition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub nodes: IndexMap<String, WorkflowNodeState>,
    pub events: Vec<WorkflowRunEvent>,
    pub gate_decisions: Vec<WorkflowGateDecision>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_session_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_input: Option<WorkflowPlanInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<WorkflowPermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncommitted_changes: Option<WorkflowUncommittedChanges>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_limit_policy: Option<WorkflowProviderLimitPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_providers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_models: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_attempts: Option<BTreeMap<String, u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autonomous_rework_attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<RunParameters>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_history: Option<Vec<WorkflowLoopIteration>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_decisions: Option<Vec<WorkflowLoopDecision>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_restore: Option<WorkflowPendingRestore>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_findings: Option<WorkflowRevisionFindings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_ai_attempt: Option<BTreeMap<String, usize>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_launch_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_delivery_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defer_merge: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_write_back_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_write_back_outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

// ── Commands ─────────────────────────────────────────────────────────────

/// An artifact a stage reports producing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredArtifact {
    pub contract_id: String,
    pub kind: WorkflowArtifactKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<WorkflowBoardReference>,
}

/// One state transition, tagged on `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WorkflowRunCommand {
    #[serde(rename_all = "camelCase")]
    NodeStarted {
        node_id: String,
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    NodeSucceeded {
        node_id: String,
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifacts: Option<Vec<DeclaredArtifact>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        snapshot_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assessed_snapshot_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        findings: Option<CheckFindings>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        independence: Option<StageIndependence>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        map_items: Option<Vec<WorkflowMapItemState>>,
    },
    #[serde(rename_all = "camelCase")]
    NodeFailed {
        node_id: String,
        at: String,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        findings: Option<CheckFindings>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pause: Option<WorkflowPauseReason>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        independence: Option<StageIndependence>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        map_items: Option<Vec<WorkflowMapItemState>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conflict_files: Option<Vec<String>>,
    },
    #[serde(rename_all = "camelCase")]
    StageProviderSwitched {
        node_id: String,
        at: String,
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        automatic: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    ProviderLimitStop {
        node_id: String,
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    NodeStopped {
        node_id: String,
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    NodeTimedOut { node_id: String, at: String },
    #[serde(rename_all = "camelCase")]
    NodeSkipped {
        node_id: String,
        at: String,
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    NodeRetry { node_id: String, at: String },
    #[serde(rename_all = "camelCase")]
    NodeInterrupted { node_id: String, at: String },
    #[serde(rename_all = "camelCase")]
    NodeProgress {
        node_id: String,
        at: String,
        phase: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    GateDecided {
        at: String,
        decision: WorkflowGateDecision,
    },
    #[serde(rename_all = "camelCase")]
    Cancel {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    LoopTaken { edge_id: String, at: String },
    #[serde(rename_all = "camelCase")]
    LoopDecided {
        edge_id: String,
        at: String,
        actor: String,
        decision: LoopDecisionKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        extra_iterations: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    LoopRestored {
        at: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

/// Inputs for [`create_workflow_run`]; optional fields default to absent.
#[derive(Debug, Clone)]
pub struct CreateWorkflowRunInput {
    pub run_id: String,
    pub project_id: String,
    pub definition: WorkflowDefinition,
    pub at: String,
    pub issue_key: Option<String>,
    pub issue_connection_id: Option<String>,
    pub scheduled_launch_token: Option<String>,
    pub shared_delivery_branch: Option<String>,
    pub defer_merge: bool,
    pub controller_session_key: Option<String>,
    pub controller_session_id: Option<String>,
    pub plan_input: Option<WorkflowPlanInput>,
    pub permission_mode: Option<WorkflowPermissionMode>,
    pub uncommitted_changes: Option<WorkflowUncommittedChanges>,
    pub ai_provider: Option<String>,
    pub ai_model: Option<String>,
    pub provider_limit_policy: Option<WorkflowProviderLimitPolicy>,
    pub parameters: Option<RunParameters>,
}

impl CreateWorkflowRunInput {
    /// The required fields; everything else starts absent.
    #[must_use]
    pub fn new(run_id: &str, project_id: &str, definition: WorkflowDefinition, at: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            project_id: project_id.to_string(),
            definition,
            at: at.to_string(),
            issue_key: None,
            issue_connection_id: None,
            scheduled_launch_token: None,
            shared_delivery_branch: None,
            defer_merge: false,
            controller_session_key: None,
            controller_session_id: None,
            plan_input: None,
            permission_mode: None,
            uncommitted_changes: None,
            ai_provider: None,
            ai_model: None,
            provider_limit_policy: None,
            parameters: None,
        }
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

fn non_empty_ref(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|v| !v.is_empty())
}

/// Creates a run pinned to a definition snapshot, with every node pending.
#[must_use]
pub fn create_workflow_run(input: CreateWorkflowRunInput) -> WorkflowRun {
    let nodes = input
        .definition
        .nodes
        .iter()
        .map(|node| (node.id().to_string(), WorkflowNodeState::pending(node.id())))
        .collect();
    let auto = input.permission_mode == Some(WorkflowPermissionMode::Auto);
    let message = if auto {
        format!(
            "Run started for {} (stage tool permissions are auto-approved).",
            input.definition.name
        )
    } else {
        format!("Run started for {}.", input.definition.name)
    };
    let mut run = WorkflowRun {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        run_id: input.run_id,
        workflow_id: input.definition.id.clone(),
        workflow_version: input.definition.version,
        project_id: input.project_id,
        status: WorkflowRunStatus::Running,
        definition: input.definition,
        display_name: None,
        nodes,
        events: Vec::new(),
        gate_decisions: Vec::new(),
        started_at: input.at.clone(),
        ended_at: None,
        ended_reason: None,
        controller_session_key: non_empty(input.controller_session_key),
        controller_session_id: non_empty(input.controller_session_id),
        plan_input: input.plan_input,
        permission_mode: auto.then_some(WorkflowPermissionMode::Auto),
        uncommitted_changes: input.uncommitted_changes,
        ai_provider: non_empty(input.ai_provider),
        ai_model: non_empty(input.ai_model),
        provider_limit_policy: input
            .provider_limit_policy
            .filter(|policy| *policy != WorkflowProviderLimitPolicy::Ask),
        stage_providers: None,
        stage_models: None,
        recovery_attempts: None,
        autonomous_rework_attempts: None,
        parameters: input.parameters.filter(|p| !p.is_empty()),
        loop_history: None,
        loop_decisions: None,
        pending_restore: None,
        revision_findings: None,
        merge_ai_attempt: None,
        worktree_path: None,
        worktree_base_ref: None,
        issue_key: non_empty(input.issue_key),
        issue_connection_id: non_empty(input.issue_connection_id),
        scheduled_launch_token: non_empty(input.scheduled_launch_token),
        shared_delivery_branch: non_empty(input.shared_delivery_branch),
        defer_merge: input.defer_merge.then_some(true),
        issue_write_back_at: None,
        issue_write_back_outcome: None,
        archived: None,
        archived_at: None,
    };
    append(
        &mut run,
        &input.at,
        WorkflowRunEventKind::RunStarted,
        None,
        None,
        message,
    );
    run
}

/// Applies one command. Returns `None` when the command is a no-op, so callers can tell
/// whether anything changed — and so a replayed command cannot append a second event.
#[must_use]
pub fn apply_workflow_run_command(
    run: &WorkflowRun,
    command: &WorkflowRunCommand,
) -> Option<WorkflowRun> {
    use WorkflowRunCommand as C;
    // A settled run absorbs nothing further, except a person retrying (or re-routing)
    // a stage of a *failed* run, gate decisions, closing orphaned stages, and restores.
    let reopens_failed_run = matches!(
        command,
        C::NodeRetry { .. } | C::StageProviderSwitched { .. }
    ) && run.status == WorkflowRunStatus::Failed;
    if is_run_settled(run)
        && !matches!(
            command,
            C::GateDecided { .. } | C::NodeStopped { .. } | C::LoopRestored { .. }
        )
        && !reopens_failed_run
    {
        return None;
    }

    match command {
        C::NodeStarted {
            node_id,
            at,
            session_id,
        } => start_node(run, node_id, at, session_id.as_ref()),
        C::NodeSucceeded {
            node_id,
            at,
            artifacts,
            exit_code,
            snapshot_ref,
            assessed_snapshot_ref,
            findings,
            provider,
            model,
            independence,
            map_items,
        } => settle_node(
            run,
            node_id,
            WorkflowNodeOutcome::Succeeded,
            at,
            SettleDetail {
                exit_code: *exit_code,
                artifacts: artifacts.as_deref().unwrap_or_default(),
                snapshot_ref: snapshot_ref.as_ref(),
                assessed_snapshot_ref: assessed_snapshot_ref.as_ref(),
                findings: findings.as_ref(),
                provider: provider.as_ref(),
                model: model.as_ref(),
                independence: independence.as_ref(),
                map_items: map_items.as_ref(),
                ..SettleDetail::default()
            },
        ),
        C::NodeFailed {
            node_id,
            at,
            error,
            exit_code,
            findings,
            pause,
            provider,
            model,
            independence,
            map_items,
            conflict_files,
        } => settle_node(
            run,
            node_id,
            WorkflowNodeOutcome::Failed,
            at,
            SettleDetail {
                error: Some(error.as_str()),
                exit_code: *exit_code,
                findings: findings.as_ref(),
                pause: *pause,
                provider: provider.as_ref(),
                model: model.as_ref(),
                independence: independence.as_ref(),
                map_items: map_items.as_ref(),
                conflict_files: conflict_files.as_ref(),
                ..SettleDetail::default()
            },
        ),
        C::StageProviderSwitched {
            node_id,
            at,
            provider,
            model,
            automatic,
        } => switch_stage_provider(
            run,
            node_id,
            at,
            provider,
            model.as_deref(),
            *automatic == Some(true),
        ),
        C::ProviderLimitStop {
            node_id,
            at,
            detail,
        } => stop_for_provider_limit(run, node_id, at, detail.as_deref()),
        C::NodeStopped {
            node_id,
            at,
            reason,
        } => stop_node(run, node_id, at, reason.as_deref()),
        C::NodeTimedOut { node_id, at } => settle_node(
            run,
            node_id,
            WorkflowNodeOutcome::Failed,
            at,
            SettleDetail {
                error: Some("Stage exceeded its timeout."),
                timed_out: true,
                ..SettleDetail::default()
            },
        ),
        C::NodeSkipped {
            node_id,
            at,
            reason,
        } => skip_node(run, node_id, at, reason),
        C::NodeRetry { node_id, at } => retry_node(run, node_id, at),
        C::NodeInterrupted { node_id, at } => interrupt_node(run, node_id, at),
        C::NodeProgress {
            node_id,
            at,
            phase,
            message,
        } => progress_node(run, node_id, at, phase, message.as_deref()),
        C::GateDecided { at, decision } => record_gate(run, at, decision),
        C::Cancel { at, reason } => Some(cancel_run(run, at, reason.as_deref())),
        C::LoopTaken { edge_id, at } => take_loop(run, edge_id, at),
        C::LoopDecided {
            edge_id,
            at,
            actor,
            decision,
            reason,
            extra_iterations,
        } => decide_loop(
            run,
            edge_id,
            at,
            actor,
            *decision,
            reason.as_deref(),
            *extra_iterations,
        ),
        C::LoopRestored { at, ok, detail } => restored_loop(run, at, *ok, detail.as_deref()),
    }
}

/// Applies a command and returns the run, unchanged when the command was a no-op.
#[must_use]
pub fn apply_command(run: WorkflowRun, command: &WorkflowRunCommand) -> WorkflowRun {
    apply_workflow_run_command(&run, command).unwrap_or(run)
}

/// Result of [`rework_workflow_run`].
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowReworkResult {
    pub run: WorkflowRun,
    /// The source plus every downstream stage returned to pending.
    pub requeued: Vec<String>,
    pub reason: Option<String>,
}

/// Options for [`rework_workflow_run`].
#[derive(Debug, Clone, Default)]
pub struct ReworkOptions {
    /// `Some(false)` leaves the source itself as it is.
    pub rerun_source: Option<bool>,
    pub reset_node_ids: Vec<String>,
    /// A person chose to start over, as opposed to a loop or recovery reopening it.
    pub by_person: bool,
    /// An autonomous rework starts a fresh attempt budget like a person-led revision.
    pub fresh_attempts: bool,
    /// Gate-failing findings this revision is meant to fix.
    pub carry_findings: Vec<RevisionFindingItem>,
}

/// Starts a new delivery revision from `node_id` without adding a cycle to the graph:
/// the stage and its downstream work return to pending, and obsolete artifacts,
/// snapshots, findings, and gate decisions are cleared so old proof cannot approve new work.
#[must_use]
pub fn rework_workflow_run(
    run: &WorkflowRun,
    node_id: &str,
    at: &str,
    options: &ReworkOptions,
) -> WorkflowReworkResult {
    let unchanged = |reason: String| WorkflowReworkResult {
        run: run.clone(),
        requeued: Vec::new(),
        reason: Some(reason),
    };
    if find_node(run, node_id).is_none() {
        return unchanged(format!("Stage \"{node_id}\" was not found."));
    }

    let mut affected = downstream_node_ids(run, node_id);
    if options.rerun_source == Some(false) {
        affected.shift_remove(node_id);
    }
    for reset in &options.reset_node_ids {
        affected.extend(downstream_node_ids(run, reset));
    }
    if affected.iter().any(|id| {
        run.nodes
            .get(id)
            .is_some_and(|s| s.outcome == WorkflowNodeOutcome::Running)
    }) {
        return unchanged(
            "Stop the in-progress downstream stage before starting rework.".to_string(),
        );
    }

    let fresh = options.by_person || options.fresh_attempts;
    let mut next = without_issue_write_back(run);
    for id in &affected {
        let Some(state) = run.nodes.get(id) else {
            continue;
        };
        let mut reset = WorkflowNodeState::pending(&state.node_id);
        reset.attempts.clone_from(&state.attempts);
        reset.revision_base = if fresh {
            Some(state.attempts.len())
        } else {
            state.revision_base
        };
        next.nodes.insert(id.clone(), reset);
    }
    let affected_gates: HashSet<_> = run
        .definition
        .nodes
        .iter()
        .filter(|node| affected.contains(node.id()))
        .filter_map(WorkflowNode::gate)
        .collect();
    next.status = WorkflowRunStatus::Running;
    next.ended_at = None;
    next.ended_reason = None;
    next.gate_decisions.retain(|decision| {
        !affected.contains(&decision.node_id) && !affected_gates.contains(&decision.gate)
    });

    let requeued: Vec<String> = affected.into_iter().collect();
    let names: Vec<String> = requeued.iter().map(|id| label(run, id)).collect();
    append(
        &mut next,
        at,
        WorkflowRunEventKind::NodeReworked,
        Some(node_id),
        None,
        format!(
            "{} opened a new delivery revision; requeued {}.",
            label(run, node_id),
            names.join(", ")
        ),
    );

    if fresh || !options.carry_findings.is_empty() {
        let carry = &options.carry_findings;
        next.revision_findings = (!carry.is_empty()).then(|| WorkflowRevisionFindings {
            at: at.to_string(),
            node_id: node_id.to_string(),
            items: carry.clone(),
        });
        let fix = if carry.is_empty() {
            String::new()
        } else {
            let mut stages: Vec<&str> = Vec::new();
            for item in carry {
                if !stages.contains(&item.stage.as_str()) {
                    stages.push(&item.stage);
                }
            }
            format!(
                " to fix {} finding{} from {}",
                carry.len(),
                plural(carry.len()),
                stages.join(", ")
            )
        };
        let who = if options.by_person {
            "A new"
        } else {
            "An autonomous"
        };
        append(
            &mut next,
            at,
            WorkflowRunEventKind::RevisionStarted,
            Some(node_id),
            None,
            format!(
                "{who} revision was started from {}{fix}.",
                label(run, node_id)
            ),
        );
    }

    WorkflowReworkResult {
        run: next,
        requeued,
        reason: None,
    }
}

// ── Transitions ──────────────────────────────────────────────────────────

fn start_node(
    run: &WorkflowRun,
    node_id: &str,
    at: &str,
    session_id: Option<&String>,
) -> Option<WorkflowRun> {
    let state = run.nodes.get(node_id)?;
    // Already running, or already settled: replaying must not open an attempt.
    if state.outcome == WorkflowNodeOutcome::Running || state.outcome.is_terminal() {
        return None;
    }
    let number = state.attempts.len() + 1;
    let mut next_state = state.clone();
    next_state.phase = None;
    next_state.outcome = WorkflowNodeOutcome::Running;
    next_state.attempts.push(WorkflowNodeAttempt {
        attempt: number,
        outcome: WorkflowNodeOutcome::Running,
        started_at: at.to_string(),
        ended_at: None,
        session_id: non_empty_ref(session_id).map(str::to_string),
        exit_code: None,
        error: None,
        pause: None,
        provider: None,
        model: None,
        independence: None,
        conflict_files: None,
    });
    let mut next = run.clone();
    next.nodes.insert(node_id.to_string(), next_state);
    append(
        &mut next,
        at,
        WorkflowRunEventKind::NodeStarted,
        Some(node_id),
        Some(number),
        format!("{} started (attempt {number}).", label(run, node_id)),
    );
    Some(next)
}

#[derive(Default)]
struct SettleDetail<'a> {
    error: Option<&'a str>,
    exit_code: Option<i64>,
    timed_out: bool,
    pause: Option<WorkflowPauseReason>,
    snapshot_ref: Option<&'a String>,
    assessed_snapshot_ref: Option<&'a String>,
    artifacts: &'a [DeclaredArtifact],
    findings: Option<&'a CheckFindings>,
    provider: Option<&'a String>,
    model: Option<&'a String>,
    independence: Option<&'a StageIndependence>,
    map_items: Option<&'a Vec<WorkflowMapItemState>>,
    conflict_files: Option<&'a Vec<String>>,
}

fn settle_node(
    run: &WorkflowRun,
    node_id: &str,
    outcome: WorkflowNodeOutcome,
    at: &str,
    detail: SettleDetail<'_>,
) -> Option<WorkflowRun> {
    let state = run.nodes.get(node_id)?;
    if state.outcome.is_terminal() || state.attempts.is_empty() {
        return None;
    }

    let node = find_node(run, node_id);
    let succeeded = outcome == WorkflowNodeOutcome::Succeeded;
    let mut effective = outcome;
    let mut error: Option<String> = detail.error.filter(|e| !e.is_empty()).map(str::to_string);
    let artifacts = if succeeded {
        to_artifact_refs(run, node_id, at, detail.artifacts)
    } else {
        Vec::new()
    };
    // A verification stage records the immutable snapshot it assessed.
    let assessed_snapshot_ref = match node {
        Some(node) if succeeded && !node.mutates_worktree() => detail
            .assessed_snapshot_ref
            .cloned()
            .or_else(|| find_snapshot(run, node_id).map(|snapshot| snapshot.reference)),
        _ => None,
    };

    // A stage that did not produce what it declared has not succeeded, whatever it reported.
    if let Some(node) = node.filter(|_| succeeded) {
        let missing: Vec<&str> = node
            .outputs()
            .iter()
            .filter(|contract| contract.required)
            .filter(|contract| !artifacts.iter().any(|a| a.contract_id == contract.id))
            .map(|contract| contract.id.as_str())
            .collect();
        if !missing.is_empty() {
            effective = WorkflowNodeOutcome::Failed;
            error = Some(format!(
                "Stage did not produce required artifacts: {}.",
                missing.join(", ")
            ));
        }
        let requires_findings = node
            .outputs()
            .iter()
            .any(|contract| contract.required && contract.kind == WorkflowArtifactKind::Findings);
        if requires_findings && detail.findings.is_none() {
            effective = WorkflowNodeOutcome::Failed;
            error.get_or_insert_with(|| {
                "Stage declared required findings artifact but produced no structured findings."
                    .to_string()
            });
        }
    }
    let failed = effective == WorkflowNodeOutcome::Failed;

    let mut next_state = state.clone();
    next_state.phase = None;
    if let Some(last) = next_state.attempts.last_mut() {
        last.outcome = effective;
        last.ended_at = Some(at.to_string());
        if detail.exit_code.is_some() {
            last.exit_code = detail.exit_code;
        }
        if error.is_some() {
            last.error.clone_from(&error);
        }
        if failed && detail.pause.is_some() {
            last.pause = detail.pause;
        }
        if let Some(provider) = non_empty_ref(detail.provider) {
            last.provider = Some(provider.to_string());
        }
        if let Some(model) = non_empty_ref(detail.model) {
            last.model = Some(model.to_string());
        }
        if let Some(independence) = detail.independence {
            last.independence = Some(independence.clone());
        }
        if failed && let Some(files) = detail.conflict_files.filter(|f| !f.is_empty()) {
            last.conflict_files = Some(files.clone());
        }
    }
    let attempt_count = next_state.attempts.len();
    next_state.outcome = effective;
    next_state.artifacts.clone_from(&artifacts);
    if !failed && let Some(snapshot) = non_empty_ref(detail.snapshot_ref) {
        next_state.snapshot_ref = Some(snapshot.to_string());
    }
    if let Some(assessed) = assessed_snapshot_ref.filter(|r| !r.is_empty()) {
        next_state.assessed_snapshot_ref = Some(assessed);
    }
    if let Some(findings) = detail.findings {
        next_state.findings = Some(findings.clone());
    }
    if let Some(items) = detail.map_items {
        next_state.map_items = Some(items.clone());
    }

    let mut next = run.clone();
    next.nodes.insert(node_id.to_string(), next_state);
    let name = label(run, node_id);
    let kind = if detail.timed_out {
        WorkflowRunEventKind::NodeTimedOut
    } else if failed {
        WorkflowRunEventKind::NodeFailed
    } else {
        WorkflowRunEventKind::NodeSucceeded
    };
    let message = if !failed {
        let note = detail
            .independence
            .filter(|i| !i.independent)
            .map(|i| format!(" {}", i.reason))
            .unwrap_or_default();
        format!("{name} succeeded.{note}")
    } else {
        match detail.pause {
            Some(WorkflowPauseReason::ProviderLimit) => format!(
                "{name} paused: {} ran out of credits or hit its usage limit. Switch to another AI, or restore them and retry — this did not use an attempt.",
                non_empty_ref(detail.provider)
                    .map_or_else(|| "the AI provider".to_string(), provider_display_name)
            ),
            Some(WorkflowPauseReason::Environment) => format!(
                "{name} paused: it could not run in this environment ({}). Fix that, then retry — this did not use an attempt.",
                first_line(error.as_deref().unwrap_or("no detail"))
            ),
            None => format!(
                "{name} failed: {}",
                error.as_deref().unwrap_or("no reason given")
            ),
        }
    };
    append(
        &mut next,
        at,
        kind,
        Some(node_id),
        Some(attempt_count),
        message,
    );

    // A skeptic's verdicts land on the findings it judged (FX-BE-164).
    if !failed
        && let Some(WorkflowNode::AgentTask(task)) = node
        && let (Some(target), Some(verdicts)) = (task.refutes.as_deref(), detail.findings)
    {
        next = apply_skeptic_verdicts(next, target, verdicts, at, &name);
    }

    next = restore_best_on_loop_exit(next, node_id, at);

    for artifact in &artifacts {
        let message = match &artifact.reference {
            Some(reference) => format!(
                "{name} created {} {} on the board: {} ({} {}).",
                artifact_kind_name(artifact.kind),
                reference.key,
                reference.title,
                reference.item_keys.len(),
                if reference.item_keys.len() == 1 {
                    "item"
                } else {
                    "items"
                }
            ),
            None => format!(
                "{name} produced {} \"{}\".",
                artifact_kind_name(artifact.kind),
                artifact.contract_id
            ),
        };
        append(
            &mut next,
            at,
            WorkflowRunEventKind::ArtifactProduced,
            Some(node_id),
            None,
            message,
        );
    }

    Some(settle_run_if_done(next, at))
}

const fn artifact_kind_name(kind: WorkflowArtifactKind) -> &'static str {
    match kind {
        WorkflowArtifactKind::Plan => "plan",
        WorkflowArtifactKind::Diff => "diff",
        WorkflowArtifactKind::Report => "report",
        WorkflowArtifactKind::TestResults => "test-results",
        WorkflowArtifactKind::Log => "log",
        WorkflowArtifactKind::Note => "note",
        WorkflowArtifactKind::Findings => "findings",
    }
}

/// Marks the judged stage's findings with a skeptic's verdicts, matched by fingerprint.
/// A skeptic may lower a severity, never raise one.
fn apply_skeptic_verdicts(
    mut run: WorkflowRun,
    target_id: &str,
    verdicts: &CheckFindings,
    at: &str,
    skeptic_name: &str,
) -> WorkflowRun {
    let Some(target) = run.nodes.get(target_id) else {
        return run;
    };
    let Some(target_findings) = &target.findings else {
        return run;
    };
    let mut refuted = 0;
    let mut confirmed = 0;
    let findings: Vec<CheckFinding> = target_findings
        .findings
        .iter()
        .map(|finding| {
            // Like a JS Map built from entries, the last verdict for a fingerprint wins.
            let Some(verdict) = verdicts
                .findings
                .iter()
                .rev()
                .find(|v| v.verdict.is_some() && v.fingerprint == finding.fingerprint)
            else {
                return finding.clone();
            };
            if verdict.verdict == Some(crate::types::FindingVerdict::Refuted) {
                refuted += 1;
            } else {
                confirmed += 1;
            }
            let mut judged = finding.clone();
            if severity_rank(verdict.severity) < severity_rank(finding.severity) {
                judged.severity = verdict.severity;
            }
            judged.verdict = verdict.verdict;
            if let Some(reason) = verdict.verdict_reason.as_ref().filter(|r| !r.is_empty()) {
                judged.verdict_reason = Some(reason.clone());
            }
            judged
        })
        .collect();
    if refuted + confirmed == 0 {
        return run;
    }
    let target_label = label(&run, target_id);
    if let Some(state) = run.nodes.get_mut(target_id)
        && let Some(existing) = state.findings.as_mut()
    {
        existing.findings = findings;
    }
    append(
        &mut run,
        at,
        WorkflowRunEventKind::NodeProgress,
        Some(target_id),
        None,
        format!(
            "{skeptic_name} checked {target_label}'s findings: {confirmed} confirmed, {refuted} refuted."
        ),
    );
    run
}

fn skip_node(run: &WorkflowRun, node_id: &str, at: &str, reason: &str) -> Option<WorkflowRun> {
    let state = run.nodes.get(node_id)?;
    if state.outcome != WorkflowNodeOutcome::Pending {
        return None;
    }
    let mut next = run.clone();
    if let Some(s) = next.nodes.get_mut(node_id) {
        s.outcome = WorkflowNodeOutcome::Skipped;
    }
    append(
        &mut next,
        at,
        WorkflowRunEventKind::NodeSkipped,
        Some(node_id),
        None,
        format!("{} skipped: {reason}", label(run, node_id)),
    );
    Some(settle_run_if_done(next, at))
}

/// Reopens a failed node for another attempt. `maxAttempts` bounds how far the run keeps
/// going on its own; it does not stop a person deciding to try again.
fn retry_node(run: &WorkflowRun, node_id: &str, at: &str) -> Option<WorkflowRun> {
    let state = run.nodes.get(node_id)?;
    if state.outcome != WorkflowNodeOutcome::Failed {
        return None;
    }
    let max_attempts = find_node(run, node_id)
        .and_then(WorkflowNode::max_attempts)
        .unwrap_or(1) as usize;
    let spent = attempts_spent(state);
    let mut next = run.clone();
    if is_run_settled(run) {
        next = without_issue_write_back(run);
        // Siblings stopped because this failure ended the run were interrupted, not judged.
        for other in next.nodes.values_mut() {
            if other.outcome == WorkflowNodeOutcome::Cancelled {
                other.outcome = WorkflowNodeOutcome::Pending;
            }
        }
    }
    if let Some(s) = next.nodes.get_mut(node_id) {
        s.outcome = WorkflowNodeOutcome::Pending;
    }
    next.status = WorkflowRunStatus::Running;
    next.ended_at = None;
    next.ended_reason = None;
    let of = if spent < max_attempts {
        format!(" of {max_attempts}")
    } else {
        String::new()
    };
    append(
        &mut next,
        at,
        WorkflowRunEventKind::NodeRetried,
        Some(node_id),
        Some(state.attempts.len()),
        format!(
            "{} queued for retry (attempt {}{of}).",
            label(run, node_id),
            spent + 1
        ),
    );
    Some(next)
}

fn without_issue_write_back(run: &WorkflowRun) -> WorkflowRun {
    let mut next = run.clone();
    next.issue_write_back_at = None;
    next
}

fn switch_stage_provider(
    run: &WorkflowRun,
    node_id: &str,
    at: &str,
    provider: &str,
    model: Option<&str>,
    automatic: bool,
) -> Option<WorkflowRun> {
    let state = run.nodes.get(node_id)?;
    if !matches!(find_node(run, node_id), Some(WorkflowNode::AgentTask(_)))
        || provider.trim().is_empty()
    {
        return None;
    }
    let from = state
        .attempts
        .last()
        .and_then(|a| non_empty_ref(a.provider.as_ref()));
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    let mut next = run.clone();
    next.stage_providers
        .get_or_insert_with(BTreeMap::new)
        .insert(node_id.to_string(), provider.to_string());
    let mut stage_models = run.stage_models.clone().unwrap_or_default();
    match model {
        Some(model) => {
            stage_models.insert(node_id.to_string(), model.to_string());
        }
        None => {
            stage_models.remove(node_id);
        }
    }
    next.stage_models = (!stage_models.is_empty()).then_some(stage_models);

    let from_text = from
        .map(|f| format!("from {} ", provider_display_name(f)))
        .unwrap_or_default();
    let ran_out = match from {
        Some(f) if pause_reason_of(state) == Some(WorkflowPauseReason::ProviderLimit) => {
            format!(" after {} ran out", provider_display_name(f))
        }
        _ => String::new(),
    };
    append(
        &mut next,
        at,
        WorkflowRunEventKind::NodeProviderSwitched,
        Some(node_id),
        None,
        format!(
            "{} switched {from_text}to {}{}{ran_out}{}.",
            label(run, node_id),
            provider_display_name(provider),
            if automatic { " automatically" } else { "" },
            model.map(|m| format!(" ({m})")).unwrap_or_default()
        ),
    );
    // A stage waiting on the AI that ran out goes again, now on the new one.
    if is_paused_node(state)
        && let Some(retried) = retry_node(&next, node_id, at)
    {
        next = retried;
    }
    Some(next)
}

fn stop_for_provider_limit(
    run: &WorkflowRun,
    node_id: &str,
    at: &str,
    detail: Option<&str>,
) -> Option<WorkflowRun> {
    let state = run.nodes.get(node_id)?;
    if pause_reason_of(state) != Some(WorkflowPauseReason::ProviderLimit) {
        return None;
    }
    let provider = state
        .attempts
        .last()
        .and_then(|a| non_empty_ref(a.provider.as_ref()));
    let reason = format!(
        "The run could not be completed: {} ran out of credits or hit its usage limit at {}{}.",
        provider.map_or_else(|| "the AI provider".to_string(), provider_display_name),
        label(run, node_id),
        detail
            .filter(|d| !d.is_empty())
            .map(|d| format!(" ({d})"))
            .unwrap_or_default()
    );
    let mut next = run.clone();
    next.status = WorkflowRunStatus::Failed;
    next.ended_at = Some(at.to_string());
    next.ended_reason = Some(reason.clone());
    append(
        &mut next,
        at,
        WorkflowRunEventKind::RunFailed,
        Some(node_id),
        None,
        reason,
    );
    Some(next)
}

/// The AIs that ran out of budget during this run, from its paused attempts.
#[must_use]
pub fn exhausted_providers(run: &WorkflowRun) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for attempt in run.nodes.values().flat_map(|state| &state.attempts) {
        if attempt.pause == Some(WorkflowPauseReason::ProviderLimit)
            && let Some(provider) = non_empty_ref(attempt.provider.as_ref())
            && !found.iter().any(|p| p == provider)
        {
            found.push(provider.to_string());
        }
    }
    found
}

/// The AI a stage runs on: one it was switched to during the run, else the stage's own
/// choice, else the run's, else `fallback`.
#[must_use]
pub fn stage_provider(run: &WorkflowRun, node_id: &str, fallback: &str) -> String {
    if let Some(switched) = run.stage_providers.as_ref().and_then(|p| p.get(node_id)) {
        return switched.clone();
    }
    let own = match find_node(run, node_id) {
        Some(WorkflowNode::AgentTask(task)) => task
            .agent
            .provider_id
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty()),
        _ => None,
    };
    own.map(str::to_string)
        .or_else(|| run.ai_provider.clone())
        .unwrap_or_else(|| fallback.to_string())
}

/// The permission mode a stage's agent session starts in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StagePermissionMode {
    Manual,
    Autopilot,
}

/// A run that auto-approves stage permissions runs its stages in Autopilot.
#[must_use]
pub fn stage_permission_mode(
    permission_mode: Option<WorkflowPermissionMode>,
) -> StagePermissionMode {
    if permission_mode == Some(WorkflowPermissionMode::Auto) {
        StagePermissionMode::Autopilot
    } else {
        StagePermissionMode::Manual
    }
}

/// Whether `provider` can run this stage at all. Antigravity has no permission relay, so
/// it can only run a Full-tools stage in Autopilot; a custom endpoint without tool support
/// cannot run stages.
#[must_use]
pub fn provider_can_run_stage(run: &WorkflowRun, node_id: &str, provider: &str) -> bool {
    if provider == "antigravity-cli" {
        let full = matches!(
            find_node(run, node_id),
            Some(WorkflowNode::AgentTask(task)) if task.agent.tool_mode == AgentToolMode::Full
        );
        return full
            && stage_permission_mode(run.permission_mode) == StagePermissionMode::Autopilot;
    }
    !custom_provider_lacks_tools(provider)
}

/// The model a stage was switched to during this run, if any.
#[must_use]
pub fn stage_model(run: &WorkflowRun, node_id: &str) -> Option<String> {
    run.stage_models.as_ref()?.get(node_id).cloned()
}

/// Closes an attempt that was in flight when the process died, as a free (paused) failure.
fn interrupt_node(run: &WorkflowRun, node_id: &str, at: &str) -> Option<WorkflowRun> {
    let state = run.nodes.get(node_id)?;
    if state.outcome != WorkflowNodeOutcome::Running {
        return None;
    }
    let mut next = run.clone();
    let s = next.nodes.get_mut(node_id)?;
    s.phase = None;
    s.outcome = WorkflowNodeOutcome::Failed;
    if let Some(last) = s.attempts.last_mut() {
        last.outcome = WorkflowNodeOutcome::Failed;
        last.ended_at = Some(at.to_string());
        last.error = Some(
            "Interrupted — the app stopped while this stage was running. Inspect its state, then retry the stage."
                .to_string(),
        );
        // Restart is not a verdict on the work: it must not consume attempts or fire failure loops.
        last.pause = Some(WorkflowPauseReason::Environment);
    }
    let count = s.attempts.len();
    append(
        &mut next,
        at,
        WorkflowRunEventKind::NodeInterrupted,
        Some(node_id),
        Some(count),
        format!("{} was interrupted by an app restart.", label(run, node_id)),
    );
    Some(settle_run_if_done(next, at))
}

/// Records a sub-phase of the running attempt; idempotent for a re-reported phase.
fn progress_node(
    run: &WorkflowRun,
    node_id: &str,
    at: &str,
    phase: &str,
    message: Option<&str>,
) -> Option<WorkflowRun> {
    let state = run.nodes.get(node_id)?;
    if state.outcome != WorkflowNodeOutcome::Running {
        return None;
    }
    let event_message = message
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map_or_else(
            || format!("{} entered phase \"{phase}\".", label(run, node_id)),
            str::to_string,
        );
    let previous = run.events.last();
    if state.phase.as_deref() == Some(phase)
        && previous.is_some_and(|p| {
            p.kind == WorkflowRunEventKind::NodeProgress && p.message == event_message
        })
    {
        return None;
    }
    let mut next = run.clone();
    let count = state.attempts.len();
    if let Some(s) = next.nodes.get_mut(node_id) {
        s.phase = Some(phase.to_string());
    }
    append(
        &mut next,
        at,
        WorkflowRunEventKind::NodeProgress,
        Some(node_id),
        Some(count),
        event_message,
    );
    next.events = compact_workflow_run_events(std::mem::take(&mut next.events), false);
    Some(next)
}

fn record_gate(
    run: &WorkflowRun,
    at: &str,
    decision: &WorkflowGateDecision,
) -> Option<WorkflowRun> {
    // One decision per gate per node; a replay must not double-log an approval.
    if run
        .gate_decisions
        .iter()
        .any(|c| c.gate == decision.gate && c.node_id == decision.node_id)
    {
        return None;
    }
    let mut next = run.clone();
    next.gate_decisions.push(decision.clone());
    let snapshot = decision
        .assessed_snapshot_ref
        .as_deref()
        .filter(|r| !r.is_empty());
    let gate = decision.gate.as_str();
    let message = if decision.bypassed {
        format!(
            "Gate \"{gate}\" bypassed by {}: {}{}",
            decision.bypassed_by.as_deref().unwrap_or("unknown"),
            decision.reason.as_deref().unwrap_or("no reason given"),
            snapshot
                .map(|s| format!(" (snapshot {s})."))
                .unwrap_or_default()
        )
    } else {
        format!(
            "Gate \"{gate}\" {}{}.",
            if decision.passed { "passed" } else { "failed" },
            snapshot
                .map(|s| format!(" (snapshot {s})"))
                .unwrap_or_default()
        )
    };
    append(
        &mut next,
        at,
        WorkflowRunEventKind::GateDecided,
        Some(&decision.node_id),
        None,
        message,
    );
    Some(next)
}

fn cancel_run(run: &WorkflowRun, at: &str, reason: Option<&str>) -> WorkflowRun {
    let mut next = run.clone();
    let ids: Vec<String> = run.nodes.keys().cloned().collect();
    for node_id in ids {
        let Some(state) = next.nodes.get_mut(&node_id) else {
            continue;
        };
        if state.outcome.is_terminal() {
            continue;
        }
        if state.outcome == WorkflowNodeOutcome::Running
            && let Some(last) = state.attempts.last_mut()
        {
            last.outcome = WorkflowNodeOutcome::Cancelled;
            last.ended_at = Some(at.to_string());
        }
        state.phase = None;
        state.outcome = WorkflowNodeOutcome::Cancelled;
        append(
            &mut next,
            at,
            WorkflowRunEventKind::NodeCancelled,
            Some(&node_id),
            None,
            format!("{} cancelled.", label(run, &node_id)),
        );
    }
    let reason = reason.filter(|r| !r.is_empty());
    next.status = WorkflowRunStatus::Cancelled;
    next.ended_at = Some(at.to_string());
    if let Some(reason) = reason {
        next.ended_reason = Some(reason.to_string());
    }
    append(
        &mut next,
        at,
        WorkflowRunEventKind::RunCancelled,
        None,
        None,
        reason.map_or_else(
            || "Run cancelled.".to_string(),
            |r| format!("Run cancelled: {r}"),
        ),
    );
    next.events = compact_workflow_run_events(std::mem::take(&mut next.events), true);
    next
}

// ── Loops (FX-BE-162) ────────────────────────────────────────────────────

/// Findings carried into a loop iteration's record, most severe first.
const LOOP_FINDINGS_CAP: usize = 40;

/// Takes a firing loop edge: only when it fires, its budget has room, and nothing is
/// running — so a replay or a stale trigger is a no-op rather than a second lap.
fn take_loop(run: &WorkflowRun, edge_id: &str, at: &str) -> Option<WorkflowRun> {
    let (kind, status) = pending_loop(run)?;
    if kind != PendingLoopKind::Take || status.edge.id != edge_id {
        return None;
    }
    if run
        .nodes
        .values()
        .any(|s| s.outcome == WorkflowNodeOutcome::Running)
    {
        return None;
    }
    let edge = &status.edge;
    let source = run.nodes.get(&edge.from)?;
    if !matches!(
        source.outcome,
        WorkflowNodeOutcome::Succeeded | WorkflowNodeOutcome::Failed
    ) {
        return None;
    }

    let iteration = status.iterations_taken + 1;
    let mut entry = loop_iteration_record(run, edge_id, iteration, at)?;

    // Keep-best: a worse iteration sends the next revision back to the best one's code.
    let mut restore: Option<WorkflowPendingRestore> = None;
    if let (Some(keep_best), Some(score)) = (
        edge.loop_budget.as_ref().and_then(|l| l.keep_best.as_ref()),
        entry.score,
    ) && let Some(best) = best_iteration(
        run.loop_history.as_deref().unwrap_or_default(),
        &edge.id,
        keep_best.higher_is_better,
    ) && let (Some(best_score), Some(best_ref)) = (best.score, best.snapshot_ref.as_ref())
        && is_worse(score, best_score, keep_best.higher_is_better)
    {
        entry.restored_to = Some(best_ref.clone());
        restore = Some(WorkflowPendingRestore {
            reference: best_ref.clone(),
            edge_id: edge.id.clone(),
            iteration: best.iteration,
            reason: format!(
                "{} fell to {score} from the best of {best_score} (iteration {}).",
                keep_best.metric, best.iteration
            ),
            at: at.to_string(),
        });
    }

    let rework = rework_workflow_run(run, &edge.to, at, &ReworkOptions::default());
    if rework.reason.is_some() {
        return None;
    }
    // Each requeued stage starts a fresh revision: its attempt budget restarts.
    let mut next = rework.run;
    for node_id in &rework.requeued {
        if let Some(state) = next.nodes.get_mut(node_id) {
            state.revision_base = Some(state.attempts.len());
        }
    }
    // A new revision gets a fresh automatic-repair budget for every check it reopened.
    if let Some(recovery) = next.recovery_attempts.as_mut() {
        recovery.retain(|check_id, _| !rework.requeued.contains(check_id));
    }
    let mut history = run.loop_history.clone().unwrap_or_default();
    let finding_count = entry.finding_count;
    let outcome = entry.outcome;
    let error = entry.error.clone();
    history.push(entry);
    next.loop_history = Some(history);
    if let Some(restore) = &restore {
        next.pending_restore = Some(restore.clone());
    }

    let why = match edge.on {
        WorkflowEdgeOutcome::Findings => format!(
            "{finding_count} finding{} matched ({})",
            plural(finding_count),
            describe_findings_predicate(edge.when.as_ref(), run.parameters.as_ref())
        ),
        WorkflowEdgeOutcome::Failure => format!(
            "it failed{}",
            error
                .as_deref()
                .filter(|e| !e.is_empty())
                .map(|e| format!(": {}", first_line(e)))
                .unwrap_or_default()
        ),
        _ => format!(
            "it {}",
            if outcome == LoopSourceOutcome::Failed {
                "failed"
            } else {
                "succeeded"
            }
        ),
    };
    let restoring = restore
        .as_ref()
        .map(|r| format!(" Restoring iteration {}'s code: {}", r.iteration, r.reason))
        .unwrap_or_default();
    append(
        &mut next,
        at,
        WorkflowRunEventKind::LoopTaken,
        Some(&edge.to),
        None,
        format!(
            "{} looped back to {} (iteration {iteration} of {}): {why}.{restoring}",
            label(run, &edge.from),
            label(run, &edge.to),
            status.budget
        ),
    );
    Some(next)
}

fn loop_iteration_record(
    run: &WorkflowRun,
    edge_id: &str,
    iteration: u32,
    at: &str,
) -> Option<WorkflowLoopIteration> {
    let edge = run.definition.edges.iter().find(|e| e.id == edge_id)?;
    let source = run.nodes.get(&edge.from);
    let mut countable = countable_findings(
        source
            .and_then(|s| s.findings.as_ref())
            .map_or(&[][..], |f| f.findings.as_slice()),
    );
    // Stable sort, most severe first — as JS `Array.prototype.sort` is stable.
    countable.sort_by_key(|finding| std::cmp::Reverse(severity_rank(finding.severity)));
    let finding_count = countable.len();
    countable.truncate(LOOP_FINDINGS_CAP);
    let last_attempt = source.and_then(|s| s.attempts.last());
    let metrics = source.and_then(|s| s.findings.as_ref()).map(|f| &f.metrics);
    let keep_best = edge.loop_budget.as_ref().and_then(|l| l.keep_best.as_ref());
    let score = keep_best
        .and_then(|keep| metrics?.get(&keep.metric).copied())
        .filter(|s| s.is_finite());
    let failed = source.is_some_and(|s| s.outcome == WorkflowNodeOutcome::Failed);
    let snapshot_ref = source
        .and_then(|s| {
            s.assessed_snapshot_ref
                .clone()
                .or_else(|| s.snapshot_ref.clone())
        })
        .or_else(|| find_snapshot(run, &edge.from).map(|snapshot| snapshot.reference));
    Some(WorkflowLoopIteration {
        edge_id: edge_id.to_string(),
        iteration,
        at: at.to_string(),
        source_node_id: edge.from.clone(),
        target_node_id: edge.to.clone(),
        outcome: if failed {
            LoopSourceOutcome::Failed
        } else {
            LoopSourceOutcome::Succeeded
        },
        findings: countable,
        finding_count,
        metrics: metrics.filter(|m| !m.is_empty()).cloned(),
        error: if failed {
            last_attempt
                .and_then(|a| a.error.clone())
                .filter(|e| !e.is_empty())
        } else {
            None
        },
        snapshot_ref: snapshot_ref.filter(|r| !r.is_empty()),
        score,
        restored_to: None,
    })
}

fn is_worse(score: f64, than: f64, higher_is_better: bool) -> bool {
    if higher_is_better {
        score < than
    } else {
        score > than
    }
}

/// The best-scoring recorded iteration of a keep-best loop. Ties keep the earliest.
#[must_use]
pub fn best_iteration<'a>(
    history: &'a [WorkflowLoopIteration],
    edge_id: &str,
    higher_is_better: bool,
) -> Option<&'a WorkflowLoopIteration> {
    let mut best: Option<&WorkflowLoopIteration> = None;
    for entry in history {
        let Some(score) = entry.score.filter(|_| entry.edge_id == edge_id) else {
            continue;
        };
        if best.is_none_or(|b| {
            b.score
                .is_some_and(|b_score| is_worse(b_score, score, higher_is_better))
        }) {
            best = Some(entry);
        }
    }
    best
}

/// When a keep-best loop's source settles and the loop will not go round again, the run
/// ends on the best iteration: ask for its code back if this result is worse.
fn restore_best_on_loop_exit(mut run: WorkflowRun, source_id: &str, at: &str) -> WorkflowRun {
    if run.pending_restore.is_some() {
        return run;
    }
    let Some(source) = run.nodes.get(source_id) else {
        return run;
    };
    if !source.outcome.is_terminal() {
        return run;
    }
    for status in loop_statuses(&run) {
        let edge = &status.edge;
        let Some(keep_best) = edge.loop_budget.as_ref().and_then(|l| l.keep_best.as_ref()) else {
            continue;
        };
        if edge.from != source_id || status.fires {
            continue;
        }
        let Some(score) = source
            .findings
            .as_ref()
            .and_then(|f| f.metrics.get(&keep_best.metric).copied())
        else {
            continue;
        };
        let history = run.loop_history.as_deref().unwrap_or_default();
        let Some(best) = best_iteration(history, &edge.id, keep_best.higher_is_better) else {
            continue;
        };
        let (Some(best_score), Some(best_ref)) = (best.score, best.snapshot_ref.clone()) else {
            continue;
        };
        if !is_worse(score, best_score, keep_best.higher_is_better) {
            continue;
        }
        let why = if status.out_of_patience {
            let patience = keep_best.patience.unwrap_or(0);
            format!(
                "{patience} pass{} in a row did not beat iteration {}'s {} of {best_score}",
                if patience == 1 { "" } else { "es" },
                best.iteration,
                keep_best.metric
            )
        } else {
            format!(
                "the final {} of {score} is worse than iteration {}'s {best_score}",
                keep_best.metric, best.iteration
            )
        };
        let iteration = best.iteration;
        let message = format!(
            "{} stops looping: {why}. The run ends on iteration {iteration}'s code.",
            label(&run, &edge.from)
        );
        run.pending_restore = Some(WorkflowPendingRestore {
            reference: best_ref,
            edge_id: edge.id.clone(),
            iteration,
            reason: format!("{why}."),
            at: at.to_string(),
        });
        append(
            &mut run,
            at,
            WorkflowRunEventKind::LoopDecided,
            Some(source_id),
            None,
            message,
        );
        return run;
    }
    run
}

#[allow(clippy::too_many_arguments)]
fn decide_loop(
    run: &WorkflowRun,
    edge_id: &str,
    at: &str,
    actor: &str,
    decision_kind: LoopDecisionKind,
    reason: Option<&str>,
    extra: Option<f64>,
) -> Option<WorkflowRun> {
    let (kind, status) = pending_loop(run)?;
    if kind != PendingLoopKind::Decide || status.edge.id != edge_id || actor.trim().is_empty() {
        return None;
    }
    let edge = &status.edge;
    let source = run.nodes.get(&edge.from)?;
    let reason = reason.map(str::trim).filter(|r| !r.is_empty());
    // Accepting a result the loop exists to fix, or ending the run, is a judgement someone answers for.
    if matches!(
        decision_kind,
        LoopDecisionKind::Accept | LoopDecisionKind::Stop
    ) && reason.is_none()
    {
        return None;
    }

    let mut extra_iterations: Option<u32> = None;
    if decision_kind == LoopDecisionKind::Grant {
        let room = i64::from(WORKFLOW_MAX_LOOP_ITERATIONS) - i64::from(status.budget);
        #[allow(clippy::cast_possible_truncation)]
        let asked = extra
            .unwrap_or(1.0)
            .floor()
            .max(1.0)
            .min(f64::from(u32::MAX)) as i64;
        let granted = room.min(asked);
        if granted < 1 {
            return None;
        }
        extra_iterations = u32::try_from(granted).ok();
    }

    let actor = actor.trim().to_string();
    let decision = WorkflowLoopDecision {
        edge_id: edge.id.clone(),
        at: at.to_string(),
        actor: actor.clone(),
        decision: decision_kind,
        reason: reason.map(str::to_string),
        extra_iterations,
        source_attempt: source.attempts.len(),
    };
    let mut next = run.clone();
    next.loop_decisions
        .get_or_insert_with(Vec::new)
        .push(decision);
    let loop_name = format!("{} → {}", label(run, &edge.from), label(run, &edge.to));
    let taken = status.iterations_taken;
    let reason_text = reason.unwrap_or_default();

    match decision_kind {
        LoopDecisionKind::Stop => {
            let ended_reason = format!(
                "Stopped by {actor} after {taken} loop iteration{} of {loop_name}: {reason_text}",
                plural(taken as usize)
            );
            append(
                &mut next,
                at,
                WorkflowRunEventKind::LoopDecided,
                Some(&edge.from),
                None,
                ended_reason.clone(),
            );
            next.status = WorkflowRunStatus::Failed;
            next.ended_at = Some(at.to_string());
            next.ended_reason = Some(ended_reason.clone());
            append(
                &mut next,
                at,
                WorkflowRunEventKind::RunFailed,
                Some(&edge.from),
                None,
                ended_reason,
            );
            Some(next)
        }
        LoopDecisionKind::Grant => {
            let extra = extra_iterations.unwrap_or(0);
            let budget = loop_budget(&next, edge);
            append(
                &mut next,
                at,
                WorkflowRunEventKind::LoopDecided,
                Some(&edge.from),
                None,
                format!(
                    "{actor} granted {extra} more iteration{} of {loop_name} (now {budget}).",
                    plural(extra as usize)
                ),
            );
            Some(next)
        }
        LoopDecisionKind::Accept => {
            // A keep-best loop ends on its best iteration.
            if let Some(keep_best) = edge.loop_budget.as_ref().and_then(|l| l.keep_best.as_ref())
                && let Some(score) = source
                    .findings
                    .as_ref()
                    .and_then(|f| f.metrics.get(&keep_best.metric).copied())
                && let Some(best) = best_iteration(
                    run.loop_history.as_deref().unwrap_or_default(),
                    &edge.id,
                    keep_best.higher_is_better,
                )
                && let (Some(best_score), Some(best_ref)) = (best.score, best.snapshot_ref.as_ref())
                && is_worse(score, best_score, keep_best.higher_is_better)
            {
                next.pending_restore = Some(WorkflowPendingRestore {
                    reference: best_ref.clone(),
                    edge_id: edge.id.clone(),
                    iteration: best.iteration,
                    reason: format!(
                        "the final {} of {score} is worse than iteration {}'s {best_score}.",
                        keep_best.metric, best.iteration
                    ),
                    at: at.to_string(),
                });
            }
            append(
                &mut next,
                at,
                WorkflowRunEventKind::LoopDecided,
                Some(&edge.from),
                None,
                format!(
                    "{actor} accepted {}'s result after {taken} iteration{} of {loop_name}: {reason_text}",
                    label(run, &edge.from),
                    plural(taken as usize)
                ),
            );
            Some(settle_run_if_done(next, at))
        }
    }
}

fn restored_loop(
    run: &WorkflowRun,
    at: &str,
    ok: bool,
    detail: Option<&str>,
) -> Option<WorkflowRun> {
    let restore = run.pending_restore.as_ref()?;
    let short: String = restore.reference.chars().take(7).collect();
    let message = if ok {
        format!(
            "Restored the code to iteration {} ({short}): {}",
            restore.iteration, restore.reason
        )
    } else {
        format!(
            "Could not restore iteration {} ({short}){} The run continues from the latest code.",
            restore.iteration,
            detail
                .filter(|d| !d.is_empty())
                .map_or_else(|| ".".to_string(), |d| format!(": {d}"))
        )
    };
    let mut next = run.clone();
    next.pending_restore = None;
    append(
        &mut next,
        at,
        WorkflowRunEventKind::LoopRestored,
        None,
        None,
        message,
    );
    Some(next)
}

/// The files a merge stage last stopped on, when its latest attempt failed on a conflict.
#[must_use]
pub fn merge_conflict_of(run: &WorkflowRun, node_id: &str) -> Option<Vec<String>> {
    let state = run.nodes.get(node_id)?;
    if state.outcome != WorkflowNodeOutcome::Failed
        || !matches!(find_node(run, node_id), Some(WorkflowNode::Merge(_)))
    {
        return None;
    }
    state
        .attempts
        .last()?
        .conflict_files
        .clone()
        .filter(|files| !files.is_empty())
}

/// A person's answer to a merge conflict: retry the merge, marking that retry (only that
/// one) to have the workflow's implementer settle the conflicts first. Returns `None`
/// when there is no conflict to resolve or the retry was refused.
#[must_use]
pub fn allow_ai_merge_resolution(
    run: &WorkflowRun,
    node_id: &str,
    at: &str,
) -> Option<WorkflowRun> {
    let files = merge_conflict_of(run, node_id)?;
    let next_attempt = run.nodes.get(node_id)?.attempts.len() + 1;
    let mut marked = run.clone();
    marked
        .merge_ai_attempt
        .get_or_insert_with(BTreeMap::new)
        .insert(node_id.to_string(), next_attempt);
    let mut retried = apply_workflow_run_command(
        &marked,
        &WorkflowRunCommand::NodeRetry {
            node_id: node_id.to_string(),
            at: at.to_string(),
        },
    )?;
    append(
        &mut retried,
        at,
        WorkflowRunEventKind::NodeRetried,
        Some(node_id),
        None,
        format!(
            "AI will resolve the merge conflicts in {}, then {} is tried again.",
            files.join(", "),
            label(run, node_id)
        ),
    );
    Some(retried)
}

// ── Derivation ───────────────────────────────────────────────────────────

/// Whether the run has ended.
#[must_use]
pub const fn is_run_settled(run: &WorkflowRun) -> bool {
    matches!(
        run.status,
        WorkflowRunStatus::Succeeded | WorkflowRunStatus::Failed | WorkflowRunStatus::Cancelled
    )
}

/// Closes the run when nothing can still move. A run fails when a *required* node has
/// failed past its retries; an advisory branch failing leaves delivery alive.
fn settle_run_if_done(mut run: WorkflowRun, at: &str) -> WorkflowRun {
    // A paused stage is waiting on the user, not finished.
    if run.nodes.values().any(is_paused_node) {
        return run;
    }
    // A firing loop edge decides where the run goes next.
    if pending_loop(&run).is_some() {
        return run;
    }

    let required_failure = run
        .nodes
        .values()
        .find(|state| {
            if state.outcome != WorkflowNodeOutcome::Failed
                || !is_required_node(&run, &state.node_id)
                || can_retry(&run, &state.node_id)
            {
                return false;
            }
            let mut failure_targets = dag_edges(&run.definition)
                .filter(|edge| {
                    edge.from == state.node_id
                        && matches!(
                            edge.on,
                            WorkflowEdgeOutcome::Failure | WorkflowEdgeOutcome::Always
                        )
                })
                .map(|edge| edge.to.as_str());
            failure_targets.all(|target| {
                run.nodes
                    .get(target)
                    .is_some_and(|s| s.outcome.is_terminal())
            })
        })
        .map(|state| state.node_id.clone());
    if let Some(node_id) = required_failure {
        run.status = WorkflowRunStatus::Failed;
        run.ended_at = Some(at.to_string());
        run.ended_reason = Some(format!("Required stage \"{node_id}\" failed."));
        let message = format!("Run failed at {}.", label(&run, &node_id));
        append(
            &mut run,
            at,
            WorkflowRunEventKind::RunFailed,
            Some(&node_id),
            None,
            message,
        );
        run.events = compact_workflow_run_events(std::mem::take(&mut run.events), true);
        return run;
    }

    if run.nodes.values().all(|state| state.outcome.is_terminal()) {
        let succeeded = run
            .nodes
            .values()
            .any(|s| s.outcome == WorkflowNodeOutcome::Succeeded);
        run.status = if succeeded {
            WorkflowRunStatus::Succeeded
        } else {
            WorkflowRunStatus::Failed
        };
        run.ended_at = Some(at.to_string());
        let (kind, message) = if succeeded {
            (WorkflowRunEventKind::RunSucceeded, "Run completed.")
        } else {
            (
                WorkflowRunEventKind::RunFailed,
                "Run ended without a successful stage.",
            )
        };
        append(&mut run, at, kind, None, None, message.to_string());
        run.events = compact_workflow_run_events(std::mem::take(&mut run.events), true);
    }
    run
}

/// Whether a failed node may still be retried under its own attempt budget.
#[must_use]
pub fn can_retry(run: &WorkflowRun, node_id: &str) -> bool {
    let (Some(state), Some(node)) = (run.nodes.get(node_id), find_node(run, node_id)) else {
        return false;
    };
    state.outcome == WorkflowNodeOutcome::Failed
        && attempts_spent(state) < node.max_attempts().unwrap_or(1) as usize
}

/// Attempts counted against `maxAttempts` in the current revision; paused attempts are free.
#[must_use]
pub fn attempts_spent(state: &WorkflowNodeState) -> usize {
    state
        .attempts
        .iter()
        .skip(state.revision_base.unwrap_or(0))
        .filter(|attempt| attempt.pause.is_none())
        .count()
}

/// Why a failed node is waiting on the user rather than failed, if it is.
#[must_use]
pub fn pause_reason_of(state: &WorkflowNodeState) -> Option<WorkflowPauseReason> {
    if state.outcome == WorkflowNodeOutcome::Failed {
        state.attempts.last()?.pause
    } else {
        None
    }
}

/// A failed node whose latest attempt stopped without a verdict.
#[must_use]
pub fn is_paused_node(state: &WorkflowNodeState) -> bool {
    pause_reason_of(state).is_some()
}

/// The first line of `text`, trimmed and capped at 160 characters.
#[must_use]
pub fn first_line(text: &str) -> String {
    let line = text.trim().split('\n').next().unwrap_or_default();
    if line.encode_utf16().count() > 160 {
        let cut: String =
            String::from_utf16_lossy(&line.encode_utf16().take(160).collect::<Vec<u16>>());
        format!("{cut}…")
    } else {
        line.to_string()
    }
}

/// Closes a stage left "running" inside a run that has already ended.
fn stop_node(
    run: &WorkflowRun,
    node_id: &str,
    at: &str,
    reason: Option<&str>,
) -> Option<WorkflowRun> {
    let state = run.nodes.get(node_id)?;
    if state.outcome != WorkflowNodeOutcome::Running {
        return None;
    }
    let mut next = run.clone();
    let s = next.nodes.get_mut(node_id)?;
    if let Some(last) = s.attempts.last_mut() {
        last.outcome = WorkflowNodeOutcome::Cancelled;
        last.ended_at = Some(at.to_string());
        last.error = Some(reason.map_or_else(
            || "Stopped: the run ended before this stage finished.".to_string(),
            str::to_string,
        ));
    }
    s.phase = None;
    s.outcome = WorkflowNodeOutcome::Cancelled;
    append(
        &mut next,
        at,
        WorkflowRunEventKind::NodeCancelled,
        Some(node_id),
        None,
        format!(
            "{} stopped: {}",
            label(run, node_id),
            reason.unwrap_or("the run ended before it finished.")
        ),
    );
    Some(next)
}

/// Whether the run depends on this node: the entry node, a parentless node, or one with
/// at least one required inbound edge.
fn is_required_node(run: &WorkflowRun, node_id: &str) -> bool {
    if node_id == run.definition.entry_node_id {
        return true;
    }
    let mut inbound = dag_edges(&run.definition)
        .filter(|edge| edge.to == node_id)
        .peekable();
    inbound.peek().is_none() || inbound.any(|edge| edge.required)
}

// ── Normalization ────────────────────────────────────────────────────────

fn lenient_vec<T: serde::de::DeserializeOwned>(value: Option<&Value>) -> Option<Vec<T>> {
    let items = value?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| serde_json::from_value(item.clone()).ok())
            .collect(),
    )
}

fn from_value<T: serde::de::DeserializeOwned>(value: Option<&Value>) -> Option<T> {
    serde_json::from_value(value?.clone()).ok()
}

fn string_of(value: Option<&Value>) -> Option<String> {
    value?.as_str().map(str::to_string)
}

fn non_negative_int(value: &Value, min: u64) -> Option<u64> {
    value.as_u64().filter(|n| *n >= min).or_else(|| {
        value
            .as_f64()
            .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n >= min as f64 && *n <= u32::MAX as f64)
            .map(|n| n as u64)
    })
}

fn string_map(value: Option<&Value>) -> Option<BTreeMap<String, String>> {
    let object = value?.as_object()?;
    Some(
        object
            .iter()
            .filter_map(|(k, v)| {
                v.as_str()
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| (k.clone(), s.to_string()))
            })
            .collect(),
    )
}

/// Repairs a run record read back from disk. History is preserved, never rebuilt: the
/// definition snapshot says what should exist, the recorded attempts say what happened.
/// Returns `None` when the value is not a run, or its definition does not parse.
#[must_use]
#[allow(
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss
)]
pub fn normalize_workflow_run(value: &Value) -> Option<WorkflowRun> {
    let raw = value.as_object()?;
    let run_id = raw
        .get("runId")?
        .as_str()
        .filter(|id| !id.is_empty())?
        .to_string();
    let definition: WorkflowDefinition = from_value(raw.get("definition"))?;
    let stored_nodes = raw.get("nodes").and_then(Value::as_object);

    let mut nodes = IndexMap::new();
    for node in &definition.nodes {
        let stored = stored_nodes
            .and_then(|n| n.get(node.id()))
            .and_then(Value::as_object);
        let field = |name: &str| stored.and_then(|s| s.get(name));
        let outcome: Option<WorkflowNodeOutcome> = from_value(field("outcome"));
        let mut state = WorkflowNodeState::pending(node.id());
        state.outcome = outcome.unwrap_or(WorkflowNodeOutcome::Pending);
        state.attempts = lenient_vec(field("attempts")).unwrap_or_default();
        state.artifacts = lenient_vec(field("artifacts")).unwrap_or_default();
        state.snapshot_ref = string_of(field("snapshotRef"));
        state.assessed_snapshot_ref = string_of(field("assessedSnapshotRef"));
        // Findings are what gate thresholds judge: dropping them would pass every threshold.
        state.findings = from_value(field("findings"));
        state.revision_base = field("revisionBase")
            .and_then(|v| non_negative_int(v, 0))
            .map(|n| n as usize);
        state.map_items = lenient_vec(field("mapItems"));
        if outcome == Some(WorkflowNodeOutcome::Running) {
            state.phase = string_of(field("phase"));
        }
        nodes.insert(node.id().to_string(), state);
    }

    let status: Option<WorkflowRunStatus> = from_value(raw.get("status"));
    let settled = matches!(
        status,
        Some(
            WorkflowRunStatus::Succeeded | WorkflowRunStatus::Failed | WorkflowRunStatus::Cancelled
        )
    );
    let events: Vec<WorkflowRunEvent> = lenient_vec(raw.get("events")).unwrap_or_default();

    let parameters: Option<RunParameters> =
        raw.get("parameters")
            .and_then(Value::as_object)
            .map(|object| {
                object
                    .iter()
                    .filter_map(|(k, v)| match v {
                        Value::String(s) => Some((k.clone(), ParameterValue::Text(s.clone()))),
                        Value::Number(n) => n
                            .as_f64()
                            .filter(|f| f.is_finite())
                            .map(|f| (k.clone(), ParameterValue::Number(f))),
                        _ => None,
                    })
                    .collect()
            });
    let loop_history: Option<Vec<WorkflowLoopIteration>> = lenient_vec(raw.get("loopHistory"));
    let loop_decisions: Option<Vec<WorkflowLoopDecision>> = lenient_vec(raw.get("loopDecisions"));
    let revision_findings: Option<WorkflowRevisionFindings> = raw
        .get("revisionFindings")
        .and_then(Value::as_object)
        .and_then(|object| {
            let at = object.get("at")?.as_str()?.to_string();
            let node_id = object.get("nodeId")?.as_str()?.to_string();
            let items: Vec<RevisionFindingItem> = lenient_vec(object.get("items"))?;
            (!items.is_empty()).then_some(WorkflowRevisionFindings { at, node_id, items })
        });
    let count_map = |name: &str, min: u64| -> Option<BTreeMap<String, u64>> {
        let object = raw.get(name)?.as_object()?;
        Some(
            object
                .iter()
                .filter_map(|(k, v)| non_negative_int(v, min).map(|n| (k.clone(), n)))
                .collect(),
        )
    };
    let display_name = string_of(raw.get("displayName"))
        .map(|name| name.trim().chars().take(120).collect::<String>())
        .filter(|name| !name.is_empty());

    Some(WorkflowRun {
        schema_version: raw
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .map_or(WORKFLOW_SCHEMA_VERSION, |v| v as u32),
        run_id,
        workflow_id: string_of(raw.get("workflowId")).unwrap_or_else(|| definition.id.clone()),
        workflow_version: raw
            .get("workflowVersion")
            .and_then(Value::as_u64)
            .map_or(definition.version, |v| v as u32),
        project_id: string_of(raw.get("projectId")).unwrap_or_default(),
        status: status.unwrap_or(WorkflowRunStatus::Running),
        definition,
        display_name,
        nodes,
        events: compact_workflow_run_events(events, settled),
        gate_decisions: lenient_vec(raw.get("gateDecisions")).unwrap_or_default(),
        started_at: string_of(raw.get("startedAt")).unwrap_or_default(),
        ended_at: string_of(raw.get("endedAt")),
        ended_reason: string_of(raw.get("endedReason")),
        controller_session_key: string_of(raw.get("controllerSessionKey")),
        controller_session_id: string_of(raw.get("controllerSessionId")),
        plan_input: from_value(raw.get("planInput")),
        permission_mode: (raw.get("permissionMode").and_then(Value::as_str) == Some("auto"))
            .then_some(WorkflowPermissionMode::Auto),
        uncommitted_changes: from_value(raw.get("uncommittedChanges")),
        ai_provider: string_of(raw.get("aiProvider")),
        ai_model: string_of(raw.get("aiModel")),
        provider_limit_policy: from_value::<WorkflowProviderLimitPolicy>(
            raw.get("providerLimitPolicy"),
        )
        .filter(|policy| *policy != WorkflowProviderLimitPolicy::Ask),
        stage_providers: string_map(raw.get("stageProviders")),
        stage_models: string_map(raw.get("stageModels")),
        recovery_attempts: count_map("recoveryAttempts", 0)
            .map(|m| m.into_iter().map(|(k, v)| (k, v as u32)).collect()),
        autonomous_rework_attempts: raw
            .get("autonomousReworkAttempts")
            .and_then(|v| non_negative_int(v, 0))
            .map(|n| n as u32),
        parameters: parameters.filter(|p| !p.is_empty()),
        loop_history: loop_history.filter(|h| !h.is_empty()),
        loop_decisions: loop_decisions.filter(|d| !d.is_empty()),
        pending_restore: from_value(raw.get("pendingRestore")),
        revision_findings,
        merge_ai_attempt: count_map("mergeAiAttempt", 1)
            .map(|m| m.into_iter().map(|(k, v)| (k, v as usize)).collect()),
        worktree_path: string_of(raw.get("worktreePath")),
        worktree_base_ref: string_of(raw.get("worktreeBaseRef")),
        issue_key: string_of(raw.get("issueKey")),
        issue_connection_id: string_of(raw.get("issueConnectionId")),
        scheduled_launch_token: string_of(raw.get("scheduledLaunchToken")),
        shared_delivery_branch: string_of(raw.get("sharedDeliveryBranch")),
        defer_merge: (raw.get("deferMerge") == Some(&Value::Bool(true))).then_some(true),
        issue_write_back_at: string_of(raw.get("issueWriteBackAt")),
        issue_write_back_outcome: string_of(raw.get("issueWriteBackOutcome")),
        archived: (raw.get("archived") == Some(&Value::Bool(true))).then_some(true),
        archived_at: string_of(raw.get("archivedAt")),
    })
}

/// Bounds transient `node-progress` events: up to 50 per node attempt while running, 10
/// once settled. Structural events are always kept.
#[must_use]
pub fn compact_workflow_run_events(
    events: Vec<WorkflowRunEvent>,
    is_settled: bool,
) -> Vec<WorkflowRunEvent> {
    let progress = events
        .iter()
        .filter(|e| e.kind == WorkflowRunEventKind::NodeProgress)
        .count();
    if progress == 0 || (!is_settled && progress <= 50) {
        return events;
    }
    let cap = if is_settled { 10 } else { 50 };
    let mut per_key: BTreeMap<(String, usize), usize> = BTreeMap::new();
    let mut keep = vec![false; events.len()];
    for (index, event) in events.iter().enumerate().rev() {
        if event.kind != WorkflowRunEventKind::NodeProgress {
            keep[index] = true;
            continue;
        }
        let key = (
            event.node_id.clone().unwrap_or_default(),
            event.attempt.unwrap_or(0),
        );
        let count = per_key.entry(key).or_insert(0);
        if *count < cap {
            *count += 1;
            keep[index] = true;
        }
    }
    events
        .into_iter()
        .zip(keep)
        .filter_map(|(event, kept)| kept.then_some(event))
        .collect()
}

// ── Helpers ──────────────────────────────────────────────────────────────

fn append(
    run: &mut WorkflowRun,
    at: &str,
    kind: WorkflowRunEventKind,
    node_id: Option<&str>,
    attempt: Option<usize>,
    message: String,
) {
    let id = format!("{}-{}", run.run_id, run.events.len());
    run.events.push(WorkflowRunEvent {
        id,
        at: at.to_string(),
        kind,
        node_id: node_id.map(str::to_string),
        attempt,
        message,
    });
}

const fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

fn find_node<'a>(run: &'a WorkflowRun, node_id: &str) -> Option<&'a WorkflowNode> {
    run.definition.node(node_id)
}

/// A node's display name, or its id when the definition no longer has it.
#[must_use]
pub fn label(run: &WorkflowRun, node_id: &str) -> String {
    find_node(run, node_id).map_or_else(|| node_id.to_string(), |node| node.name().to_string())
}

/// `node_id` and everything reachable from it along DAG edges, in breadth-first order.
#[must_use]
pub fn downstream_node_ids(run: &WorkflowRun, node_id: &str) -> indexmap::IndexSet<String> {
    let mut outbound: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for edge in dag_edges(&run.definition) {
        outbound
            .entry(edge.from.as_str())
            .or_default()
            .push(edge.to.as_str());
    }
    let mut affected = indexmap::IndexSet::new();
    let mut pending: VecDeque<&str> = VecDeque::from([node_id]);
    while let Some(current) = pending.pop_front() {
        if !affected.insert(current.to_string()) {
            continue;
        }
        pending.extend(outbound.get(current).into_iter().flatten().copied());
    }
    affected
}

fn to_artifact_refs(
    run: &WorkflowRun,
    node_id: &str,
    at: &str,
    declared: &[DeclaredArtifact],
) -> Vec<WorkflowArtifactRef> {
    let Some(node) = find_node(run, node_id) else {
        return Vec::new();
    };
    let contracts: HashSet<&str> = node.outputs().iter().map(|c| c.id.as_str()).collect();
    // An artifact the node never declared is dropped. Indices count after filtering, as in TS.
    declared
        .iter()
        .filter(|artifact| contracts.contains(artifact.contract_id.as_str()))
        .enumerate()
        .map(|(index, artifact)| WorkflowArtifactRef {
            artifact_id: artifact
                .artifact_id
                .clone()
                .unwrap_or_else(|| format!("{}-{node_id}-{index}", run.run_id)),
            contract_id: artifact.contract_id.clone(),
            node_id: node_id.to_string(),
            run_id: run.run_id.clone(),
            kind: artifact.kind,
            path: non_empty_ref(artifact.path.as_ref()).map(str::to_string),
            reference: artifact.reference.clone(),
            created_at: at.to_string(),
        })
        .collect()
}
