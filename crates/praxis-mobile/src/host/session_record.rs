//! The slice of an agent session record (`AgentSessionRecord` / `AgentEventSummary` in
//! `packages/core/src/ai/agentTypes.ts`) the mobile projections read.
//!
//! The AI session service is not in Rust yet, so this is a read-only view that deserialises from
//! the TS record's JSON (unknown fields ignored). Values the phone receives verbatim — token
//! usage, cost, attachments, tool data — stay `serde_json::Value` so their shape and key order
//! pass through untouched.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileTaskDefinition {
    #[serde(default)]
    pub goal: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSessionEventRecord {
    pub timestamp: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gadget_answer: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_names: Option<Vec<String>>,
}

impl MobileSessionEventRecord {
    pub fn new(timestamp: &str, kind: &str, summary: &str) -> Self {
        Self {
            timestamp: timestamp.to_owned(),
            kind: kind.to_owned(),
            summary: summary.to_owned(),
            ..Self::default()
        }
    }

    pub fn with_detail(mut self, detail: &str) -> Self {
        self.detail = Some(detail.to_owned());
        self
    }

    /// `event.detail` when truthy (non-empty).
    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref().filter(|d| !d.is_empty())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSessionRecord {
    pub issue_key: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_key: Option<String>,
    /// `AgentTaskState`: `planning`, `executing`, `awaiting_approval`, `completed`, …
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub task_definition: MobileTaskDefinition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default)]
    pub events: Vec<MobileSessionEventRecord>,
    #[serde(default)]
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<Value>,
}

impl MobileSessionRecord {
    /// `record.projectId` when truthy.
    pub fn project(&self) -> Option<&str> {
        self.project_id.as_deref().filter(|p| !p.is_empty())
    }
}

/// `Some(value)` unless it is an empty string (the TS `...(x ? { x } : {})` spread).
pub(crate) fn truthy(value: &Option<String>) -> Option<&String> {
    value.as_ref().filter(|v| !v.is_empty())
}
