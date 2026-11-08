//! MCP protocol and message types for JSON-RPC 2.0 communication.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CONNECT_TIMEOUT_SECS: u64 = 20;
pub const CALL_TIMEOUT_SECS: u64 = 120;
pub const MAX_RESULT_CHARS: usize = 60_000;
pub const MAX_TOOL_NAME: usize = 64;

/// JSON-RPC 2.0 request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl JsonRpcRequest {
    pub fn new(id: impl Into<Value>, method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

/// JSON-RPC 2.0 response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

impl JsonRpcResponse {
    pub fn success(id: impl Into<Value>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: id.into(),
            result: Some(result),
            error: None,
        }
    }

    pub fn error(
        id: impl Into<Value>,
        code: i64,
        message: impl Into<String>,
        data: Option<Value>,
    ) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: id.into(),
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data,
            }),
        }
    }
}

/// JSON-RPC 2.0 error object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Tool information returned by an MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

/// Result of calling an MCP tool, flattened into text for a language model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallToolResult {
    pub ok: bool,
    pub content: String,
}

impl CallToolResult {
    pub fn success(content: impl Into<String>) -> Self {
        Self {
            ok: true,
            content: content.into(),
        }
    }

    pub fn failure(content: impl Into<String>) -> Self {
        Self {
            ok: false,
            content: content.into(),
        }
    }
}

/// Result of probing an MCP server (e.g. testing connectivity and listing tools).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProbeResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    pub tools: Vec<McpToolInfo>,
}

/// Content block in an MCP tool result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpContentBlock {
    Text {
        text: String,
    },
    Resource {
        resource: Value,
    },
    #[serde(other)]
    Other,
}
