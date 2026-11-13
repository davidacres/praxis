//! Coordination MCP server for multi-agent cooperation (`coordination.rs`).

use serde_json::{Value, json};

use crate::mcp::types::McpToolInfo;

pub const COORDINATION_MCP_SERVER_NAME: &str = "praxis-coordination";

/// Returns the tool descriptors for the coordination MCP server.
#[must_use]
pub fn list_coordination_tools() -> Vec<McpToolInfo> {
    vec![
        McpToolInfo {
            name: "coordination_status".to_string(),
            description: Some("List the other agent sessions working in this repository: what each holds, who is waiting, and recent notes. Read this before starting work another session might be doing. Pass `since` (the number the last answer ended with) to get only what changed.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "since": { "type": "number", "description": "The event number the previous coordination_status answer ended at." }
                },
                "additionalProperties": false
            })),
        },
        McpToolInfo {
            name: "coordination_claim".to_string(),
            description: Some("Claim files or folders (paths relative to the repository) and/or the running app before you change them, so other sessions do not edit them at the same time. Fails at once, naming the holder, if another session has them: do not retry in a loop. Your claims are released when your turn ends.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "paths": { "type": "array", "items": { "type": "string" }, "description": "Files or folders, relative to the repository root. A folder covers everything under it." },
                    "app": { "type": "boolean", "description": "Also claim the running app / in-app browser for a sequence of UI actions." },
                    "reason": { "type": "string", "description": "What you are about to do, in a few words." }
                },
                "required": ["reason"],
                "additionalProperties": false
            })),
        },
        McpToolInfo {
            name: "coordination_wait".to_string(),
            description: Some("Wait for files, folders or the running app that another session holds, after a claim or write was refused. Waits in turn for at most `seconds` (max 120), then either gives them to you until your turn ends or says what is still in the way. Call it once; do not loop. Re-read what you waited for before changing it.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "paths": { "type": "array", "items": { "type": "string" }, "description": "Files or folders, relative to the repository root." },
                    "app": { "type": "boolean", "description": "Wait for the running app / in-app browser." },
                    "reason": { "type": "string", "description": "What you will do with them, in a few words." },
                    "seconds": { "type": "number", "description": "How long to wait, 1-120 (default 60)." }
                },
                "required": ["reason"],
                "additionalProperties": false
            })),
        },
        McpToolInfo {
            name: "coordination_release".to_string(),
            description: Some("Release everything you claimed, as soon as you are done with it.".to_string()),
            input_schema: Some(json!({ "type": "object", "properties": {}, "additionalProperties": false })),
        },
        McpToolInfo {
            name: "coordination_message".to_string(),
            description: Some("Leave a short note for the other sessions in this repository (or one of them): a handoff, or what you just finished.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "to": { "type": "string", "description": "A session key, or omit for everyone." },
                    "needs_ack": { "type": "boolean", "description": "Ask the recipient to acknowledge it (a handoff that needs a reply)." }
                },
                "required": ["text"],
                "additionalProperties": false
            })),
        },
        McpToolInfo {
            name: "coordination_ack".to_string(),
            description: Some("Acknowledge a note that asked for it, by its number from coordination_status.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": { "sequence": { "type": "number" } },
                "required": ["sequence"],
                "additionalProperties": false
            })),
        },
    ]
}

/// The longest one `coordination_wait` call may wait.
pub const COORDINATION_MCP_MAX_WAIT_MS: i64 = 120_000;

/// What the coordination tools do for one session, supplied by the host that owns the broker.
/// Peer text returned by `status` is data, never instructions.
#[async_trait::async_trait]
pub trait CoordinationSessionHooks: Send + Sync {
    /// Who is working on what; with `since`, only what happened after that event number.
    async fn status(&self, since: Option<i64>) -> String;
    async fn claim(&self, paths: Vec<String>, app: bool, reason: String) -> (bool, String);
    /// Bounded wait for what another session holds; held until the turn ends once granted.
    async fn wait(
        &self,
        paths: Vec<String>,
        app: bool,
        reason: String,
        timeout_ms: i64,
    ) -> (bool, String);
    async fn release(&self) -> String;
    async fn message(&self, text: String, to: Option<String>, needs_ack: bool) -> (bool, String);
    async fn ack(&self, sequence: i64) -> (bool, String);
}

struct Targets {
    paths: Vec<String>,
    app: bool,
    reason: String,
}

fn claim_targets(args: &Value) -> Result<Targets, String> {
    let paths: Vec<String> = args
        .get("paths")
        .and_then(Value::as_array)
        .map(|all| {
            all.iter()
                .filter_map(Value::as_str)
                .filter(|p| !p.trim().is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    let app = args.get("app").and_then(Value::as_bool) == Some(true);
    let reason = args
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map_or_else(|| "working".to_owned(), |r| r.chars().take(200).collect());
    if paths.is_empty() && !app {
        return Err("Name at least one path, or set app: true.".to_owned());
    }
    if paths.len() > 50 {
        return Err("Name at most 50 paths at once; use a folder instead.".to_owned());
    }
    Ok(Targets { paths, app, reason })
}

/// Runs one coordination tool against a session's hooks (`executeCoordinationTool`).
pub async fn execute_coordination_tool_with_hooks(
    name: &str,
    args: &Value,
    hooks: &dyn CoordinationSessionHooks,
) -> (bool, String) {
    match name {
        "coordination_status" => {
            let since = args
                .get("since")
                .and_then(Value::as_f64)
                .filter(|n| *n > 0.0)
                .map(|n| n.floor() as i64);
            (true, hooks.status(since).await)
        }
        "coordination_claim" => match claim_targets(args) {
            Ok(t) => hooks.claim(t.paths, t.app, t.reason).await,
            Err(error) => (false, error),
        },
        "coordination_wait" => match claim_targets(args) {
            Ok(t) => {
                let seconds = args
                    .get("seconds")
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite())
                    .unwrap_or(60.0);
                let timeout_ms =
                    ((seconds * 1000.0).round() as i64).clamp(1000, COORDINATION_MCP_MAX_WAIT_MS);
                hooks.wait(t.paths, t.app, t.reason, timeout_ms).await
            }
            Err(error) => (false, error),
        },
        "coordination_ack" => match args
            .get("sequence")
            .and_then(Value::as_f64)
            .map(f64::floor)
            .filter(|n| n.is_finite() && *n > 0.0)
        {
            Some(sequence) => hooks.ack(sequence as i64).await,
            None => (false, "Give the note's number.".to_owned()),
        },
        "coordination_release" => (true, hooks.release().await),
        "coordination_message" => {
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if text.is_empty() {
                return (false, "A message needs text.".to_owned());
            }
            let to = args
                .get("to")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(ToString::to_string);
            hooks
                .message(
                    text.to_owned(),
                    to,
                    args.get("needs_ack").and_then(Value::as_bool) == Some(true),
                )
                .await
        }
        _ => (false, format!("Unknown tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recording(std::sync::Mutex<Vec<String>>);

    #[async_trait::async_trait]
    impl CoordinationSessionHooks for Recording {
        async fn status(&self, since: Option<i64>) -> String {
            self.0
                .lock()
                .expect("lock")
                .push(format!("status {since:?}"));
            "status".into()
        }
        async fn claim(&self, paths: Vec<String>, app: bool, reason: String) -> (bool, String) {
            self.0
                .lock()
                .expect("lock")
                .push(format!("claim {paths:?} {app} {reason}"));
            (true, "claimed".into())
        }
        async fn wait(
            &self,
            paths: Vec<String>,
            app: bool,
            reason: String,
            timeout_ms: i64,
        ) -> (bool, String) {
            self.0
                .lock()
                .expect("lock")
                .push(format!("wait {paths:?} {app} {reason} {timeout_ms}"));
            (true, "waited".into())
        }
        async fn release(&self) -> String {
            self.0.lock().expect("lock").push("release".into());
            "released".into()
        }
        async fn message(
            &self,
            text: String,
            to: Option<String>,
            needs_ack: bool,
        ) -> (bool, String) {
            self.0
                .lock()
                .expect("lock")
                .push(format!("message {text} {to:?} {needs_ack}"));
            (true, "sent".into())
        }
        async fn ack(&self, sequence: i64) -> (bool, String) {
            self.0.lock().expect("lock").push(format!("ack {sequence}"));
            (true, "acked".into())
        }
    }

    #[tokio::test]
    async fn tool_arguments_are_validated_before_the_hooks_run() {
        let hooks = Recording::default();
        let run = |name: &'static str, args: Value| {
            let hooks = &hooks;
            async move { execute_coordination_tool_with_hooks(name, &args, hooks).await }
        };
        assert_eq!(
            run("coordination_claim", json!({ "reason": "x" })).await,
            (false, "Name at least one path, or set app: true.".into())
        );
        let many: Vec<String> = (0..51).map(|n| format!("f{n}")).collect();
        assert!(
            !run(
                "coordination_claim",
                json!({ "paths": many, "reason": "x" })
            )
            .await
            .0
        );
        assert_eq!(
            run("coordination_ack", json!({ "sequence": 0 })).await,
            (false, "Give the note's number.".into())
        );
        assert_eq!(
            run("coordination_message", json!({ "text": "  " })).await,
            (false, "A message needs text.".into())
        );
        assert_eq!(
            run("coordination_nope", json!({})).await,
            (false, "Unknown tool: coordination_nope".into())
        );
        assert!(
            hooks.0.lock().expect("lock").is_empty(),
            "nothing reached the hooks"
        );
    }

    #[tokio::test]
    async fn a_wait_is_bounded_and_defaults_to_a_minute() {
        let hooks = Recording::default();
        execute_coordination_tool_with_hooks(
            "coordination_wait",
            &json!({ "paths": ["a"], "reason": "edit" }),
            &hooks,
        )
        .await;
        execute_coordination_tool_with_hooks(
            "coordination_wait",
            &json!({ "paths": ["a"], "reason": "edit", "seconds": 9999 }),
            &hooks,
        )
        .await;
        execute_coordination_tool_with_hooks(
            "coordination_wait",
            &json!({ "app": true, "reason": "edit", "seconds": 0.1 }),
            &hooks,
        )
        .await;
        execute_coordination_tool_with_hooks(
            "coordination_status",
            &json!({ "since": 7.9 }),
            &hooks,
        )
        .await;
        execute_coordination_tool_with_hooks(
            "coordination_message",
            &json!({ "text": "hi", "to": " B ", "needs_ack": true }),
            &hooks,
        )
        .await;
        let seen = hooks.0.lock().expect("lock").clone();
        assert_eq!(
            seen,
            vec![
                "wait [\"a\"] false edit 60000".to_owned(),
                "wait [\"a\"] false edit 120000".to_owned(),
                "wait [] true edit 1000".to_owned(),
                "status Some(7)".to_owned(),
                "message hi Some(\"B\") true".to_owned(),
            ]
        );
    }
}
