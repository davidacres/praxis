//! The durable ledger of AI usage events (`aiUsageLog.ts` port, the event shape only).
//!
//! One entry per reported usage delta, source-tagged, kept forever so the schedule can work out
//! what earlier runs of a workflow cost. A delta is never a running total: the host diffs the
//! provider's cumulative figure into a delta before it reaches here.

use serde::{Deserialize, Serialize};

/// Where the usage came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiUsageSource {
    Session,
    WorkflowRecommendation,
    WorkflowTemplateRecommendation,
    WorkflowModelRecommendation,
    PromptAnalysis,
    PromptCalibration,
}

/// One reported usage delta.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageEvent {
    pub id: String,
    /// ISO 8601.
    pub timestamp: String,
    pub source: AiUsageSource,
    /// The agent session this usage belongs to, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// A delta for this one event, never a running total.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<f64>,
    /// A delta for this one event. Only ACP hosts report cost at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<AiUsageCost>,
    /// Set when this usage happened inside a governed workflow run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_node_id: Option<String>,
}

/// What one usage event cost.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiUsageCost {
    pub amount: f64,
    pub currency: String,
}
