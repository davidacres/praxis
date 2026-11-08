//! Versioned contracts for interactive chat gadgets (`contracts.rs`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const GADGET_CONTRACT_VERSION: u32 = 1;

/// The 12 supported gadget kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GadgetKind {
    Choice,
    Confirmation,
    Form,
    Table,
    Chart,
    Progress,
    Diff,
    Artifact,
    Image,
    Handoff,
    Conflict,
    Approval,
}

impl GadgetKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Choice => "choice",
            Self::Confirmation => "confirmation",
            Self::Form => "form",
            Self::Table => "table",
            Self::Chart => "chart",
            Self::Progress => "progress",
            Self::Diff => "diff",
            Self::Artifact => "artifact",
            Self::Image => "image",
            Self::Handoff => "handoff",
            Self::Conflict => "conflict",
            Self::Approval => "approval",
        }
    }
}

/// Scope bounding a gadget to the host, session, and project it was issued in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GadgetScope {
    pub host_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GadgetActionEffect {
    Informational,
    Mutating,
    Approval,
}

/// Descriptor of an actionable button/control on a gadget surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GadgetActionDescriptor {
    pub action_id: String,
    pub label: String,
    pub effect: GadgetActionEffect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub danger: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Value submitted by the user when executing an action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum GadgetActionValue {
    None,
    Choice { selected: String },
    Confirmation { confirmed: bool },
    Form { fields: BTreeMap<String, Value> },
    Selection { selected: Vec<String> },
}

/// Complete submission packet for a gadget action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GadgetAction {
    pub version: u32,
    pub gadget_id: String,
    pub action_id: String,
    pub scope: GadgetScope,
    pub idempotency_key: String,
    pub correlation_id: String,
    pub submitted_at: String,
    pub value: GadgetActionValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GadgetError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

impl GadgetError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            path: None,
            retryable: Some(false),
        }
    }
}

/// Envelope enclosing a typed gadget and its metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GadgetEnvelope {
    pub version: u32,
    pub gadget_id: String,
    pub kind: GadgetKind,
    pub scope: GadgetScope,
    pub issued_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    pub fallback_text: String,
    pub payload: Value,
    #[serde(default)]
    pub actions: Vec<GadgetActionDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>, // "active", "submitted", "completed", etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<GadgetActionValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
}

/// Ordered blocks comprising an AI assistant turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ChatBlock {
    Markdown {
        block_id: String,
        markdown: String,
    },
    Gadget {
        block_id: String,
        gadget: Box<GadgetEnvelope>,
    },
    Fallback {
        block_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<GadgetError>,
    },
}
