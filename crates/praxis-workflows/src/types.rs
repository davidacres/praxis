//! Governed delivery workflow contracts (`workflowTypes.ts` port).
//!
//! A workflow is a validated DAG of stages a project runs to deliver one unit of
//! work: agents implement, deterministic checks verify, and a human approves.
//! Every type here round-trips the same camelCase JSON the TypeScript engine
//! stores, so definitions and runs can move between the two runtimes unchanged.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::waivers::FindingWaiver;

/// Bumped only for a breaking shape change; `migrateWorkflow` handles the lift.
pub const WORKFLOW_SCHEMA_VERSION: u32 = 1;

/// The most iterations any loop may run, whatever its budget or grants say.
pub const WORKFLOW_MAX_LOOP_ITERATIONS: u32 = 10;

/// Where a definition, policy, or agent lives. `project` shadows `global` by id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowScope {
    Global,
    Project,
}

/// Host-enforced tool access for an agent session (`AgentToolMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentToolMode {
    ReadOnly,
    Full,
    ProjectOnly,
}

// ── Agent binding ────────────────────────────────────────────────────────

/// Capabilities a stage needs from its agent host. An unset flag means "don't care".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCapabilityRequirement {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_skills: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_tools: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_memory: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_resume: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_streaming: Option<bool>,
}

/// A stage's agent, by identity rather than by value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAgentRef {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub scope: WorkflowScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_fingerprints: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_capabilities: Option<WorkflowCapabilityRequirement>,
    pub tool_mode: AgentToolMode,
}

// ── Artifacts ────────────────────────────────────────────────────────────

/// What a stage hands to the next one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowArtifactKind {
    Plan,
    Diff,
    Report,
    TestResults,
    Log,
    Note,
    Findings,
}

// ── Findings & metrics ───────────────────────────────────────────────────

/// Finding severity, ordered from least to most severe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckFindingSeverity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

/// A skeptic stage's judgement of a finding (FX-BE-164).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FindingVerdict {
    Confirmed,
    Refuted,
}

/// One normalized finding from a check or review stage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFinding {
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    pub severity: CheckFindingSeverity,
    pub category: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    /// A `refuted` finding is kept on the record but no longer counts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<FindingVerdict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict_reason: Option<String>,
}

/// Findings plus numeric metrics produced by one stage.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CheckFindings {
    pub findings: Vec<CheckFinding>,
    pub metrics: BTreeMap<String, f64>,
}

/// Deterministic fingerprint over rule id, normalized file path, line number, and message.
#[must_use]
pub fn compute_finding_fingerprint(
    rule_id: Option<&str>,
    file: Option<&str>,
    line: Option<i64>,
    message: &str,
) -> String {
    let norm_file = file.unwrap_or("").replace('\\', "/");
    let payload = format!(
        "{}::{}::{}::{}",
        rule_id.unwrap_or("").trim(),
        norm_file.trim(),
        line.map(|l| l.to_string()).unwrap_or_default(),
        message.trim()
    );
    Sha256::digest(payload.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// ── Gate thresholds ──────────────────────────────────────────────────────

/// Comparison used by metric thresholds and findings predicates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MetricOperator {
    #[serde(rename = ">=")]
    Gte,
    #[serde(rename = "<=")]
    Lte,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = "==")]
    Eq,
}

impl MetricOperator {
    /// The operator's source spelling (`>=`, `<`, …).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Gte => ">=",
            Self::Lte => "<=",
            Self::Gt => ">",
            Self::Lt => "<",
            Self::Eq => "==",
        }
    }
}

/// A gate threshold: a metric comparison or a cap on findings at a severity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum GateThresholdCondition {
    #[serde(rename_all = "camelCase")]
    Metric {
        metric: String,
        operator: MetricOperator,
        value: f64,
    },
    #[serde(rename_all = "camelCase")]
    Severity {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        severity_level: Option<CheckFindingSeverity>,
        max_count: f64,
    },
}

/// Named adapter for parsing raw tool output into [`CheckFindings`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckResultAdapterKind {
    Sarif,
    Junit,
    Lcov,
    Cobertura,
    NpmAudit,
    OsvScanner,
}

/// Where a `plan` artifact is published.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactPublishTarget {
    Board,
}

/// A declared output slot on a node. Presence is checked; content is not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowArtifactContract {
    pub id: String,
    pub kind: WorkflowArtifactKind,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<CheckResultAdapterKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish_to: Option<ArtifactPublishTarget>,
}

// ── Gates ────────────────────────────────────────────────────────────────

/// The evidence classes a policy can insist on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowGateKind {
    Review,
    Qa,
    Security,
}

impl WorkflowGateKind {
    /// The gate's wire spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Review => "review",
            Self::Qa => "qa",
            Self::Security => "security",
        }
    }
}

/// Gate kind → threshold conditions.
pub type GateThresholds = BTreeMap<WorkflowGateKind, Vec<GateThresholdCondition>>;

// ── Nodes ────────────────────────────────────────────────────────────────

/// How much model a stage needs, independent of provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowModelTier {
    Fast,
    Standard,
    Strong,
}

impl WorkflowModelTier {
    /// The tier's wire spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Standard => "standard",
            Self::Strong => "strong",
        }
    }
}

impl std::fmt::Display for WorkflowModelTier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Tiers from weakest to strongest.
pub const WORKFLOW_MODEL_TIERS: [WorkflowModelTier; 3] = [
    WorkflowModelTier::Fast,
    WorkflowModelTier::Standard,
    WorkflowModelTier::Strong,
];

/// Fields every node shares.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeBase {
    pub id: String,
    pub name: String,
    /// Designer canvas position. Execution ignores these entirely.
    pub x: f64,
    pub y: f64,
    /// Artifact contract ids this node consumes; each must exist upstream.
    pub inputs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

/// Test-guard settings for a mutating stage (FX-BE-166).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardTests {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tests_in_scope: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
}

/// A stage run by an agent session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAgentTaskNode {
    #[serde(flatten)]
    pub base: WorkflowNodeBase,
    pub agent: WorkflowAgentRef,
    pub instructions: String,
    pub outputs: Vec<WorkflowArtifactContract>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_pack_id: Option<String>,
    pub mutates_worktree: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub satisfies_gate: Option<WorkflowGateKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_tier: Option<WorkflowModelTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escalate_on_retry: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard_tests: Option<GuardTests>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub independent_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refutes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
}

/// CI evidence provider for an observing check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObserveProvider {
    GithubActions,
    GitlabCi,
}

/// Observe mode for CI-provided evidence (FX-BE-091).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckObserve {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ObserveProvider>,
}

/// Bounded self-healing path for a failing check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFailureRecovery {
    pub repair_node_id: String,
    pub max_attempts: u32,
}

/// A deterministic command whose exit code decides the outcome.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCheckNode {
    #[serde(flatten)]
    pub base: WorkflowNodeBase,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Defaults to `[0]` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success_exit_codes: Option<Vec<i32>>,
    pub outputs: Vec<WorkflowArtifactContract>,
    /// Defaults to **false** — the opposite of agent stages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mutates_worktree: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub satisfies_gate: Option<WorkflowGateKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<CheckResultAdapterKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observe: Option<CheckObserve>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_recovery: Option<CheckFailureRecovery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affected_tests: Option<bool>,
}

/// A stage that ships a built artifact through a deployment profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDeploymentNode {
    #[serde(flatten)]
    pub base: WorkflowNodeBase,
    pub deployment_profile_id: String,
    pub outputs: Vec<WorkflowArtifactContract>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub satisfies_gate: Option<WorkflowGateKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
}

/// A human decision. Always terminal for its branch until someone acts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowApprovalNode {
    #[serde(flatten)]
    pub base: WorkflowNodeBase,
    pub prompt: String,
    pub required_gates: Vec<WorkflowGateKind>,
    pub allow_bypass: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_thresholds: Option<GateThresholds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waivers: Option<Vec<FindingWaiver>>,
}

/// How a join converges its inbound branches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JoinMode {
    All,
    AllRequired,
}

/// Converges parallel branches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJoinNode {
    #[serde(flatten)]
    pub base: WorkflowNodeBase,
    pub mode: JoinMode,
}

/// What a merge does on conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MergeConflictPolicy {
    Fail,
    AiResolve,
}

/// What an undeclared change does to the merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutOfScopePolicy {
    Block,
    Escalate,
}

/// Merges the run's branch into its target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMergeNode {
    #[serde(flatten)]
    pub base: WorkflowNodeBase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_fast_forward: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_conflict: Option<MergeConflictPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out_of_scope: Option<OutOfScopePolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
}

/// How a map node reads items from its `over` artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MapItemSource {
    Findings,
    PlanItems,
}

/// What a map node does when an item fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MapItemFailure {
    #[serde(rename = "collect")]
    Collect,
    #[serde(rename = "failFast")]
    FailFast,
}

/// Runs one agent stage per item of a list known only at run time (FX-BE-165).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMapNode {
    #[serde(flatten)]
    pub base: WorkflowNodeBase,
    pub over: String,
    pub item_source: MapItemSource,
    pub agent: WorkflowAgentRef,
    pub instructions: String,
    pub mutates_worktree: bool,
    pub concurrency: u32,
    pub max_items: u32,
    pub on_item_failure: MapItemFailure,
    pub outputs: Vec<WorkflowArtifactContract>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub satisfies_gate: Option<WorkflowGateKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_tier: Option<WorkflowModelTier>,
}

/// One stage of a workflow, tagged on `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WorkflowNode {
    #[serde(rename = "agent-task")]
    AgentTask(WorkflowAgentTaskNode),
    #[serde(rename = "check")]
    Check(WorkflowCheckNode),
    #[serde(rename = "deployment")]
    Deployment(WorkflowDeploymentNode),
    #[serde(rename = "approval")]
    Approval(WorkflowApprovalNode),
    #[serde(rename = "join")]
    Join(WorkflowJoinNode),
    #[serde(rename = "merge")]
    Merge(WorkflowMergeNode),
    #[serde(rename = "map")]
    Map(WorkflowMapNode),
}

impl WorkflowNode {
    /// Fields shared by every node type.
    #[must_use]
    pub const fn base(&self) -> &WorkflowNodeBase {
        match self {
            Self::AgentTask(n) => &n.base,
            Self::Check(n) => &n.base,
            Self::Deployment(n) => &n.base,
            Self::Approval(n) => &n.base,
            Self::Join(n) => &n.base,
            Self::Merge(n) => &n.base,
            Self::Map(n) => &n.base,
        }
    }

    /// Mutable access to the shared fields.
    pub const fn base_mut(&mut self) -> &mut WorkflowNodeBase {
        match self {
            Self::AgentTask(n) => &mut n.base,
            Self::Check(n) => &mut n.base,
            Self::Deployment(n) => &mut n.base,
            Self::Approval(n) => &mut n.base,
            Self::Join(n) => &mut n.base,
            Self::Merge(n) => &mut n.base,
            Self::Map(n) => &mut n.base,
        }
    }

    /// The node's id.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.base().id
    }

    /// The node's display name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.base().name
    }

    /// The `type` tag (`agent-task`, `check`, …).
    #[must_use]
    pub const fn type_name(&self) -> &'static str {
        match self {
            Self::AgentTask(_) => "agent-task",
            Self::Check(_) => "check",
            Self::Deployment(_) => "deployment",
            Self::Approval(_) => "approval",
            Self::Join(_) => "join",
            Self::Merge(_) => "merge",
            Self::Map(_) => "map",
        }
    }

    /// Whether the node runs; absent `enabled` means enabled.
    #[must_use]
    pub fn is_enabled(&self) -> bool {
        self.base().enabled != Some(false)
    }

    /// Declared artifact outputs. Approval, merge and join stages produce none.
    #[must_use]
    pub fn outputs(&self) -> &[WorkflowArtifactContract] {
        match self {
            Self::AgentTask(n) => &n.outputs,
            Self::Check(n) => &n.outputs,
            Self::Deployment(n) => &n.outputs,
            Self::Map(n) => &n.outputs,
            Self::Approval(_) | Self::Join(_) | Self::Merge(_) => &[],
        }
    }

    /// The gate a node stands behind, when it stands behind one.
    #[must_use]
    pub const fn gate(&self) -> Option<WorkflowGateKind> {
        match self {
            Self::AgentTask(n) => n.satisfies_gate,
            Self::Check(n) => n.satisfies_gate,
            Self::Deployment(n) => n.satisfies_gate,
            Self::Map(n) => n.satisfies_gate,
            Self::Approval(_) | Self::Join(_) | Self::Merge(_) => None,
        }
    }

    /// Whether a stage writes to the canonical implementation worktree.
    #[must_use]
    pub fn mutates_worktree(&self) -> bool {
        match self {
            Self::AgentTask(n) => n.mutates_worktree,
            Self::Check(n) => n.mutates_worktree == Some(true),
            Self::Merge(_) => true,
            Self::Map(n) => n.mutates_worktree,
            Self::Deployment(_) | Self::Approval(_) | Self::Join(_) => false,
        }
    }

    /// A node's own `maxAttempts`, when its type has one.
    #[must_use]
    pub const fn max_attempts(&self) -> Option<u32> {
        match self {
            Self::AgentTask(n) => n.max_attempts,
            Self::Check(n) => n.max_attempts,
            Self::Deployment(n) => n.max_attempts,
            Self::Merge(n) => n.max_attempts,
            Self::Approval(_) | Self::Join(_) | Self::Map(_) => None,
        }
    }

    /// A node's own `timeoutMs`, when its type has one.
    #[must_use]
    pub const fn timeout_ms(&self) -> Option<u64> {
        match self {
            Self::AgentTask(n) => n.timeout_ms,
            Self::Check(n) => n.timeout_ms,
            Self::Deployment(n) => n.timeout_ms,
            Self::Merge(n) => n.timeout_ms,
            Self::Map(n) => n.timeout_ms,
            Self::Approval(_) | Self::Join(_) => None,
        }
    }
}

// ── Edges ────────────────────────────────────────────────────────────────

/// Which outcome traverses an edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowEdgeOutcome {
    Success,
    Failure,
    Always,
    Findings,
}

/// A metric clause of a findings predicate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingsMetricClause {
    pub metric: String,
    pub operator: MetricOperator,
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_from_parameter: Option<String>,
}

/// Which findings a `findings` edge routes on. Clauses are alternatives.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFindingsPredicate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<CheckFindingSeverity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<FindingsMetricClause>,
}

/// Keep-best settings on a loop budget (FX-BE-166).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopKeepBest {
    pub metric: String,
    pub higher_is_better: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patience: Option<u32>,
}

/// A back-edge's bound (FX-BE-162).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLoopBudget {
    pub max_iterations: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_best: Option<LoopKeepBest>,
}

/// A directed edge between two nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub on: WorkflowEdgeOutcome,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<WorkflowFindingsPredicate>,
    #[serde(default, rename = "loop", skip_serializing_if = "Option::is_none")]
    pub loop_budget: Option<WorkflowLoopBudget>,
}

/// The value type a run parameter accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowRunParameterKind {
    Text,
    Integer,
    Number,
}

/// A run parameter value: text or a number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParameterValue {
    Number(f64),
    Text(String),
}

/// A value a person supplies when starting a run (FX-BE-166).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunParameter {
    pub id: String,
    pub label: String,
    pub kind: WorkflowRunParameterKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<ParameterValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binds_loop_edge: Option<String>,
}

// ── Definition ───────────────────────────────────────────────────────────

/// How a workflow is started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowTrigger {
    OnDemand,
    Ticket,
}

/// A validated workflow graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<WorkflowTrigger>,
    pub scope: WorkflowScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub version: u32,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    pub entry_node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Vec<WorkflowRunParameter>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_measurable_goal: Option<bool>,
    pub created_at: String,
    pub updated_at: String,
}

impl WorkflowDefinition {
    /// Finds a node by id.
    #[must_use]
    pub fn node(&self, id: &str) -> Option<&WorkflowNode> {
        self.nodes.iter().find(|node| node.id() == id)
    }
}

// ── Policy ───────────────────────────────────────────────────────────────

/// The rules a project imposes on any workflow it runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPolicyProfile {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub scope: WorkflowScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub required_gates: Vec<WorkflowGateKind>,
    pub require_human_approval: bool,
    pub allow_gate_bypass: bool,
    pub require_trusted_agents: bool,
    pub max_attempts_per_node: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_thresholds: Option<GateThresholds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waivers: Option<Vec<FindingWaiver>>,
    pub created_at: String,
    pub updated_at: String,
}

// ── Run references ───────────────────────────────────────────────────────

/// States a node attempt can hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowNodeOutcome {
    Pending,
    Ready,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

impl WorkflowNodeOutcome {
    /// Whether an outcome is settled, so callers stop treating a node as live.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Skipped | Self::Cancelled
        )
    }
}

/// Identifies a run without dragging its whole event log along.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunRef {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_version: u32,
    pub project_id: String,
    pub started_at: String,
}

/// A plan published to a project board.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowBoardReference {
    pub key: String,
    pub title: String,
    pub item_keys: Vec<String>,
}

/// A produced artifact, addressed by the contract slot that declared it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowArtifactRef {
    pub artifact_id: String,
    pub contract_id: String,
    pub node_id: String,
    pub run_id: String,
    pub kind: WorkflowArtifactKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<WorkflowBoardReference>,
    pub created_at: String,
}

/// A recorded gate decision; bypass fields make an override auditable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowGateDecision {
    pub gate: WorkflowGateKind,
    pub node_id: String,
    pub passed: bool,
    pub bypassed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bypassed_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assessed_snapshot_ref: Option<String>,
    pub decided_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fingerprint_normalizes_separators_and_whitespace_and_is_stable() {
        let a = compute_finding_fingerprint(Some(" r1 "), Some("src\\a.ts"), Some(3), " msg ");
        let b = compute_finding_fingerprint(Some("r1"), Some("src/a.ts"), Some(3), "msg");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert_ne!(
            a,
            compute_finding_fingerprint(Some("r1"), Some("src/a.ts"), Some(4), "msg")
        );
        // Same digest Node's `createHash('sha256')` gives for the TS payload.
        assert_eq!(
            b,
            "05f3f9905557500d31e13b8d81a4212ad63e2d7cf6a0901b089cce9cda2e2eda"
        );
    }

    #[test]
    fn nodes_round_trip_the_typescript_json_shape() {
        let raw = json!({
            "id": "implement", "name": "Implement", "type": "agent-task", "x": 0, "y": 10.5,
            "inputs": [], "instructions": "do it", "mutatesWorktree": true, "outputs": [],
            "agent": { "agentId": "a", "scope": "global", "toolMode": "read-only" },
            "modelTier": "strong"
        });
        let node: WorkflowNode = serde_json::from_value(raw).expect("agent node");
        assert_eq!(node.id(), "implement");
        assert!(node.mutates_worktree());
        assert_eq!(node.type_name(), "agent-task");
        let back = serde_json::to_value(&node).expect("serialize");
        assert_eq!(back["type"], "agent-task");
        assert_eq!(back["agent"]["toolMode"], "read-only");
        assert_eq!(back["modelTier"], "strong");
        assert!(back.get("timeoutMs").is_none());

        let check: WorkflowNode = serde_json::from_value(json!({
            "id": "c", "name": "C", "type": "check", "x": 0, "y": 0, "inputs": [],
            "command": "npm", "outputs": []
        }))
        .expect("check node");
        assert!(!check.mutates_worktree());
        let merge: WorkflowNode = serde_json::from_value(json!({
            "id": "m", "name": "M", "type": "merge", "x": 0, "y": 0, "inputs": []
        }))
        .expect("merge node");
        assert!(merge.mutates_worktree());
    }

    #[test]
    fn edges_and_thresholds_use_wire_spellings() {
        let edge: WorkflowEdge = serde_json::from_value(json!({
            "id": "e", "from": "a", "to": "b", "on": "findings", "required": true,
            "when": { "severity": "high", "metric": { "metric": "cov", "operator": ">=", "value": 80 } },
            "loop": { "maxIterations": 3 }
        }))
        .expect("edge");
        assert_eq!(edge.loop_budget.as_ref().map(|l| l.max_iterations), Some(3));
        let condition: GateThresholdCondition = serde_json::from_value(
            json!({ "type": "severity", "severityLevel": "critical", "maxCount": 0 }),
        )
        .expect("threshold");
        assert_eq!(
            serde_json::to_value(&condition).expect("serialize")["type"],
            "severity"
        );
        assert!(CheckFindingSeverity::Critical > CheckFindingSeverity::High);
        assert!(WorkflowNodeOutcome::Skipped.is_terminal());
        assert!(!WorkflowNodeOutcome::Ready.is_terminal());
    }
}
