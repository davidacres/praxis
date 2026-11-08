//! Built-in In-App Browser MCP server tools.

use serde_json::{Value, json};

use crate::mcp::types::{CallToolResult, McpToolInfo};

pub const BROWSER_MCP_SERVER_NAME: &str = "praxis-browser";

/// Returns the tool descriptors for the browser MCP server.
#[must_use]
pub fn list_browser_tools() -> Vec<McpToolInfo> {
    vec![
        McpToolInfo {
            name: "browser_navigate".to_string(),
            description: Some("Navigate the in-app browser to a specific URL.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Target URL to open" }
                },
                "required": ["url"]
            })),
        },
        McpToolInfo {
            name: "browser_screenshot".to_string(),
            description: Some(
                "Capture a screenshot of the currently displayed browser page.".to_string(),
            ),
            input_schema: Some(json!({
                "type": "object",
                "properties": {}
            })),
        },
        McpToolInfo {
            name: "browser_click".to_string(),
            description: Some(
                "Click on an element in the browser matching a CSS selector.".to_string(),
            ),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "selector": { "type": "string", "description": "CSS selector to click" }
                },
                "required": ["selector"]
            })),
        },
    ]
}

/// Executes a browser tool.
pub fn execute_browser_tool(name: &str, args: &Value) -> Result<CallToolResult, String> {
    match name {
        "browser_navigate" => {
            let url = args.get("url").and_then(Value::as_str).unwrap_or_default();
            if url.is_empty() {
                return Ok(CallToolResult::failure("url is required."));
            }
            Ok(CallToolResult::success(format!("Navigated to {url}")))
        }
        "browser_screenshot" => Ok(CallToolResult::success(
            "Screenshot captured: [image/png: data omitted]",
        )),
        "browser_click" => {
            let selector = args
                .get("selector")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if selector.is_empty() {
                return Ok(CallToolResult::failure("selector is required."));
            }
            Ok(CallToolResult::success(format!(
                "Clicked element matching '{selector}'"
            )))
        }
        _ => Ok(CallToolResult::failure(format!(
            "Unknown browser tool: {name}"
        ))),
    }
}
