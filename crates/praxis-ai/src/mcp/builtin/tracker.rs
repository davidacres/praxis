//! Built-in Tracker MCP server (`tracker.rs`).

use async_trait::async_trait;
use praxis_workflows::types::AgentToolMode;
use serde_json::{Value, json};

use crate::mcp::types::{CallToolResult, McpToolInfo};

/// Provider trait for tracker backend operations.
#[async_trait]
pub trait TrackerProvider: Send + Sync {
    async fn get_ticket(&self, issue_key: &str) -> Result<Value, String>;
    async fn list_transitions(&self, issue_key: &str) -> Result<Vec<Value>, String>;
    async fn add_comment(&self, issue_key: &str, body: &str) -> Result<(), String>;
    async fn update_ticket(&self, issue_key: &str, fields: &Value) -> Result<(), String>;
    async fn transition_ticket(&self, issue_key: &str, transition_id: &str) -> Result<(), String>;
}

/// Returns the tool descriptors for the tracker MCP server.
#[must_use]
pub fn list_tracker_tools() -> Vec<McpToolInfo> {
    vec![
        McpToolInfo {
            name: "tracker_get_ticket".to_string(),
            description: Some("Get the current details of a ticket from the session tracker connection.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "issueKey": { "type": "string", "description": "Ticket key, for example APP-101" }
                },
                "required": ["issueKey"]
            })),
        },
        McpToolInfo {
            name: "tracker_list_transitions".to_string(),
            description: Some("List the workflow transitions currently available for a ticket.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "issueKey": { "type": "string" }
                },
                "required": ["issueKey"]
            })),
        },
        McpToolInfo {
            name: "tracker_add_comment".to_string(),
            description: Some("Add a comment or progress update to a ticket.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "issueKey": { "type": "string" },
                    "body": { "type": "string" }
                },
                "required": ["issueKey", "body"]
            })),
        },
        McpToolInfo {
            name: "tracker_update_ticket".to_string(),
            description: Some("Update editable ticket fields after user approval.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "issueKey": { "type": "string" },
                    "summary": { "type": "string" },
                    "description": { "type": "string" },
                    "assignee": { "type": ["string", "null"] },
                    "priority": { "type": "string" }
                },
                "required": ["issueKey"]
            })),
        },
        McpToolInfo {
            name: "tracker_transition_ticket".to_string(),
            description: Some("Move a ticket through a workflow transition. Accepts transition ID or status name.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "issueKey": { "type": "string" },
                    "transitionId": { "type": "string", "description": "Transition ID or target status name" }
                },
                "required": ["issueKey", "transitionId"]
            })),
        },
    ]
}

/// Executes a tracker tool call against the provided tracker provider,
/// enforcing tool mode permission boundaries.
pub async fn execute_tracker_tool(
    name: &str,
    args: &Value,
    tool_mode: AgentToolMode,
    provider: &dyn TrackerProvider,
) -> Result<CallToolResult, String> {
    let issue_key = args
        .get("issueKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();

    if issue_key.is_empty() {
        return Ok(CallToolResult::failure("issueKey is required."));
    }

    match name {
        "tracker_get_ticket" => {
            let ticket = provider.get_ticket(issue_key).await?;
            let serialized = serde_json::to_string_pretty(&ticket)
                .map_err(|e| format!("Failed to serialize ticket: {e}"))?;
            Ok(CallToolResult::success(serialized))
        }
        "tracker_list_transitions" => {
            let transitions = provider.list_transitions(issue_key).await?;
            let serialized = serde_json::to_string_pretty(&transitions)
                .map_err(|e| format!("Failed to serialize transitions: {e}"))?;
            Ok(CallToolResult::success(serialized))
        }
        "tracker_add_comment" => {
            if tool_mode == AgentToolMode::ReadOnly {
                return Ok(CallToolResult::failure(format!(
                    "Cannot execute write tool {name} in read-only mode."
                )));
            }
            let body = args
                .get("body")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if body.is_empty() {
                return Ok(CallToolResult::failure("body is required."));
            }
            provider.add_comment(issue_key, body).await?;
            Ok(CallToolResult::success(format!(
                "Comment added to {issue_key}."
            )))
        }
        "tracker_update_ticket" => {
            if tool_mode == AgentToolMode::ReadOnly {
                return Ok(CallToolResult::failure(format!(
                    "Cannot execute write tool {name} in read-only mode."
                )));
            }
            provider.update_ticket(issue_key, args).await?;
            Ok(CallToolResult::success(format!(
                "Ticket {issue_key} updated."
            )))
        }
        "tracker_transition_ticket" => {
            if tool_mode == AgentToolMode::ReadOnly {
                return Ok(CallToolResult::failure(format!(
                    "Cannot execute write tool {name} in read-only mode."
                )));
            }
            let transition_id = args
                .get("transitionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if transition_id.is_empty() {
                return Ok(CallToolResult::failure("transitionId is required."));
            }
            provider.transition_ticket(issue_key, transition_id).await?;
            Ok(CallToolResult::success(format!(
                "Ticket {issue_key} transitioned with {transition_id}."
            )))
        }
        _ => Ok(CallToolResult::failure(format!(
            "Unknown tracker tool: {name}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockTracker;

    #[async_trait]
    impl TrackerProvider for MockTracker {
        async fn get_ticket(&self, key: &str) -> Result<Value, String> {
            Ok(json!({ "key": key, "summary": "Fix bug in parser" }))
        }

        async fn list_transitions(&self, _key: &str) -> Result<Vec<Value>, String> {
            Ok(vec![json!({ "id": "start", "name": "Start Work" })])
        }

        async fn add_comment(&self, _key: &str, _body: &str) -> Result<(), String> {
            Ok(())
        }

        async fn update_ticket(&self, _key: &str, _fields: &Value) -> Result<(), String> {
            Ok(())
        }

        async fn transition_ticket(&self, _key: &str, _id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn allows_read_tools_in_read_only_mode() {
        let tracker = MockTracker;
        let args = json!({ "issueKey": "PRX-1" });
        let res = execute_tracker_tool(
            "tracker_get_ticket",
            &args,
            AgentToolMode::ReadOnly,
            &tracker,
        )
        .await
        .expect("call succeeds");

        assert!(res.ok);
        assert!(res.content.contains("Fix bug in parser"));
    }

    #[tokio::test]
    async fn blocks_write_tools_in_read_only_mode() {
        let tracker = MockTracker;
        let args = json!({ "issueKey": "PRX-1", "body": "Progress report" });
        let res = execute_tracker_tool(
            "tracker_add_comment",
            &args,
            AgentToolMode::ReadOnly,
            &tracker,
        )
        .await
        .expect("call returns failure CallToolResult");

        assert!(!res.ok);
        assert!(
            res.content
                .contains("Cannot execute write tool tracker_add_comment in read-only mode")
        );
    }

    #[tokio::test]
    async fn permits_write_tools_in_full_mode() {
        let tracker = MockTracker;
        let args = json!({ "issueKey": "PRX-1", "body": "Progress report" });
        let res = execute_tracker_tool("tracker_add_comment", &args, AgentToolMode::Full, &tracker)
            .await
            .expect("call succeeds");

        assert!(res.ok);
        assert_eq!(res.content, "Comment added to PRX-1.");
    }
}
