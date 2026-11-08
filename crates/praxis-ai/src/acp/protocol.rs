//! Agent Client Protocol (ACP) JSON-RPC schemas and notification types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ACP_PROTOCOL_VERSION: u32 = 1;

/// ACP Permission decisions returned to an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpPermissionDecision {
    AllowOnce,
    AllowAlways,
    Deny,
}

/// Known tool kinds reported in ACP notifications and permission requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AcpToolKind {
    Read,
    Search,
    Think,
    Fetch,
    Execute,
    Edit,
    Delete,
    Move,
    Other(String),
}

impl From<&str> for AcpToolKind {
    fn from(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "read" => Self::Read,
            "search" => Self::Search,
            "think" => Self::Think,
            "fetch" => Self::Fetch,
            "execute" => Self::Execute,
            "edit" => Self::Edit,
            "delete" => Self::Delete,
            "move" => Self::Move,
            other => Self::Other(other.to_string()),
        }
    }
}

impl AcpToolKind {
    /// Returns true if this tool kind is safe to execute in read-only mode.
    #[must_use]
    pub fn is_read_only(&self) -> bool {
        matches!(self, Self::Read | Self::Search | Self::Think | Self::Fetch)
    }
}

/// Request sent by an agent CLI asking for permission to execute a tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionRequest {
    pub tool_call_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<Value>,
    #[serde(default)]
    pub options: Vec<AcpPermissionOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

/// Response returned to an agent permission request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionResponse {
    pub decision: AcpPermissionDecision,
}

/// Incoming update notification streamed by an agent during a prompt turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub enum AcpSessionUpdate {
    AgentMessageChunk {
        content: AcpMessageContent,
    },
    ToolCall {
        tool_call_id: String,
        title: Option<String>,
        name: Option<String>,
        kind: Option<String>,
        raw_input: Option<Value>,
        status: Option<String>,
    },
    ToolCallUpdate {
        tool_call_id: String,
        status: String,
        raw_output: Option<Value>,
        content: Option<Value>,
    },
    AvailableCommandsUpdate {
        available_commands: Vec<AcpAvailableCommand>,
    },
    CurrentModeUpdate {
        current_mode_id: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AcpMessageContent {
    Text {
        text: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAvailableCommand {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Prompt response returned when an agent completes a turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptResponse {
    pub stop_reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<Value>,
}
