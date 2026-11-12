//! Coordination MCP server for multi-agent cooperation (`coordination.rs`).

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::mcp::types::{CallToolResult, McpToolInfo};

pub const COORDINATION_MCP_SERVER_NAME: &str = "praxis-coordination";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveClaim {
    pub session_id: String,
    pub path: Option<String>,
    pub app: bool,
    pub reason: String,
    pub claimed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoordinationNote {
    pub sequence: u64,
    pub from_session: String,
    pub to_session: Option<String>,
    pub text: String,
    pub needs_ack: bool,
    pub acked: bool,
    pub timestamp: String,
}

/// Thread-safe in-memory coordination hub.
#[derive(Default, Clone)]
pub struct CoordinationHub {
    claims: Arc<Mutex<HashMap<String, ActiveClaim>>>, // Key is path or "__app__"
    notes: Arc<Mutex<Vec<CoordinationNote>>>,
}

impl CoordinationHub {
    pub fn new() -> Self {
        Self {
            claims: Arc::new(Mutex::new(HashMap::new())),
            notes: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn status(&self, since: Option<u64>) -> String {
        let claims = self.claims.lock().await;
        let notes = self.notes.lock().await;

        let mut lines = Vec::new();
        lines.push("### Active Claims".to_string());
        if claims.is_empty() {
            lines.push("- (no active claims)".to_string());
        } else {
            for (target, claim) in claims.iter() {
                lines.push(format!(
                    "- [{}] '{}' claimed by {} ({})",
                    claim.claimed_at, target, claim.session_id, claim.reason
                ));
            }
        }

        lines.push("".to_string());
        lines.push("### Coordination Notes".to_string());
        let filtered_notes: Vec<&CoordinationNote> = if let Some(s) = since {
            notes.iter().filter(|n| n.sequence > s).collect()
        } else {
            notes.iter().collect()
        };

        if filtered_notes.is_empty() {
            lines.push("- (no notes)".to_string());
        } else {
            for note in filtered_notes {
                let to_info = note
                    .to_session
                    .as_deref()
                    .map(|t| format!(" to {t}"))
                    .unwrap_or_default();
                let ack_info = if note.needs_ack {
                    if note.acked {
                        " [acknowledged]"
                    } else {
                        " [needs ack]"
                    }
                } else {
                    ""
                };
                lines.push(format!(
                    "#{}: [{}] {}{}{}: {}",
                    note.sequence, note.timestamp, note.from_session, to_info, ack_info, note.text
                ));
            }
        }

        let max_seq = notes.last().map(|n| n.sequence).unwrap_or(0);
        lines.push(format!("\nStatus snapshot ended at sequence {max_seq}."));

        lines.join("\n")
    }

    pub async fn claim(
        &self,
        session_id: &str,
        paths: &[String],
        app: bool,
        reason: &str,
    ) -> Result<String, String> {
        if paths.is_empty() && !app {
            return Err("Name at least one path, or set app: true.".to_string());
        }
        if paths.len() > 50 {
            return Err("Name at most 50 paths at once; use a folder instead.".to_string());
        }

        let mut claims = self.claims.lock().await;
        let now = Utc::now().to_rfc3339();

        // Check conflicts
        if app {
            if let Some(existing) = claims.get("__app__") {
                if existing.session_id != session_id {
                    return Err(format!(
                        "The running app is already held by session {} for '{}'.",
                        existing.session_id, existing.reason
                    ));
                }
            }
        }

        for path in paths {
            if let Some(existing) = claims.get(path) {
                if existing.session_id != session_id {
                    return Err(format!(
                        "Path '{}' is already held by session {} for '{}'.",
                        path, existing.session_id, existing.reason
                    ));
                }
            }
        }

        // Apply claims
        if app {
            claims.insert(
                "__app__".to_string(),
                ActiveClaim {
                    session_id: session_id.to_string(),
                    path: None,
                    app: true,
                    reason: reason.to_string(),
                    claimed_at: now.clone(),
                },
            );
        }

        for path in paths {
            claims.insert(
                path.clone(),
                ActiveClaim {
                    session_id: session_id.to_string(),
                    path: Some(path.clone()),
                    app: false,
                    reason: reason.to_string(),
                    claimed_at: now.clone(),
                },
            );
        }

        Ok(format!("Claim acquired by {session_id} for: {reason}"))
    }

    pub async fn release(&self, session_id: &str) -> String {
        let mut claims = self.claims.lock().await;
        let before_count = claims.len();
        claims.retain(|_, v| v.session_id != session_id);
        let released = before_count - claims.len();
        format!("Released {released} claims held by {session_id}.")
    }

    pub async fn message(
        &self,
        from_session: &str,
        text: &str,
        to_session: Option<String>,
        needs_ack: bool,
    ) -> u64 {
        let mut notes = self.notes.lock().await;
        let seq = (notes.len() + 1) as u64;
        notes.push(CoordinationNote {
            sequence: seq,
            from_session: from_session.to_string(),
            to_session,
            text: text.to_string(),
            needs_ack,
            acked: false,
            timestamp: Utc::now().to_rfc3339(),
        });
        seq
    }

    pub async fn ack(&self, sequence: u64) -> Result<(), String> {
        let mut notes = self.notes.lock().await;
        if let Some(note) = notes.iter_mut().find(|n| n.sequence == sequence) {
            note.acked = true;
            Ok(())
        } else {
            Err(format!(
                "No coordination note found with sequence {sequence}"
            ))
        }
    }
}

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
    async fn wait(&self, paths: Vec<String>, app: bool, reason: String, timeout_ms: i64) -> (bool, String);
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
        .map(|all| all.iter().filter_map(Value::as_str).filter(|p| !p.trim().is_empty()).map(ToString::to_string).collect())
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
pub async fn execute_coordination_tool_with_hooks(name: &str, args: &Value, hooks: &dyn CoordinationSessionHooks) -> (bool, String) {
    match name {
        "coordination_status" => {
            let since = args.get("since").and_then(Value::as_f64).filter(|n| *n > 0.0).map(|n| n.floor() as i64);
            (true, hooks.status(since).await)
        }
        "coordination_claim" => match claim_targets(args) {
            Ok(t) => hooks.claim(t.paths, t.app, t.reason).await,
            Err(error) => (false, error),
        },
        "coordination_wait" => match claim_targets(args) {
            Ok(t) => {
                let seconds = args.get("seconds").and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(60.0);
                let timeout_ms = ((seconds * 1000.0).round() as i64).clamp(1000, COORDINATION_MCP_MAX_WAIT_MS);
                hooks.wait(t.paths, t.app, t.reason, timeout_ms).await
            }
            Err(error) => (false, error),
        },
        "coordination_ack" => match args.get("sequence").and_then(Value::as_f64).map(f64::floor).filter(|n| n.is_finite() && *n > 0.0) {
            Some(sequence) => hooks.ack(sequence as i64).await,
            None => (false, "Give the note's number.".to_owned()),
        },
        "coordination_release" => (true, hooks.release().await),
        "coordination_message" => {
            let text = args.get("text").and_then(Value::as_str).map(str::trim).unwrap_or_default();
            if text.is_empty() {
                return (false, "A message needs text.".to_owned());
            }
            let to = args.get("to").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(ToString::to_string);
            hooks.message(text.to_owned(), to, args.get("needs_ack").and_then(Value::as_bool) == Some(true)).await
        }
        _ => (false, format!("Unknown tool: {name}")),
    }
}

/// Executes a coordination tool against the hub.
pub async fn execute_coordination_tool(
    name: &str,
    args: &Value,
    session_id: &str,
    hub: &CoordinationHub,
) -> Result<CallToolResult, String> {
    match name {
        "coordination_status" => {
            let since = args.get("since").and_then(Value::as_u64);
            let text = hub.status(since).await;
            Ok(CallToolResult::success(text))
        }
        "coordination_claim" => {
            let paths: Vec<String> = args
                .get("paths")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let app = args.get("app").and_then(Value::as_bool).unwrap_or(false);
            let reason = args
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("working");

            match hub.claim(session_id, &paths, app, reason).await {
                Ok(msg) => Ok(CallToolResult::success(msg)),
                Err(err) => Ok(CallToolResult::failure(err)),
            }
        }
        "coordination_wait" => {
            // In synchronous execution or single turn, try claim once
            let paths: Vec<String> = args
                .get("paths")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let app = args.get("app").and_then(Value::as_bool).unwrap_or(false);
            let reason = args
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("waiting");

            match hub.claim(session_id, &paths, app, reason).await {
                Ok(msg) => Ok(CallToolResult::success(msg)),
                Err(err) => Ok(CallToolResult::failure(format!("Wait ended: {err}"))),
            }
        }
        "coordination_release" => {
            let text = hub.release(session_id).await;
            Ok(CallToolResult::success(text))
        }
        "coordination_message" => {
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "text is required".to_string())?;
            let to = args
                .get("to")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let needs_ack = args
                .get("needs_ack")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let seq = hub.message(session_id, text, to, needs_ack).await;
            Ok(CallToolResult::success(format!(
                "Message posted as #{seq}."
            )))
        }
        "coordination_ack" => {
            let sequence = args
                .get("sequence")
                .and_then(Value::as_u64)
                .ok_or_else(|| "sequence is required".to_string())?;
            match hub.ack(sequence).await {
                Ok(()) => Ok(CallToolResult::success(format!(
                    "Acknowledged note #{sequence}."
                ))),
                Err(e) => Ok(CallToolResult::failure(e)),
            }
        }
        _ => Ok(CallToolResult::failure(format!(
            "Unknown coordination tool: {name}"
        ))),
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
            self.0.lock().expect("lock").push(format!("status {since:?}"));
            "status".into()
        }
        async fn claim(&self, paths: Vec<String>, app: bool, reason: String) -> (bool, String) {
            self.0.lock().expect("lock").push(format!("claim {paths:?} {app} {reason}"));
            (true, "claimed".into())
        }
        async fn wait(&self, paths: Vec<String>, app: bool, reason: String, timeout_ms: i64) -> (bool, String) {
            self.0.lock().expect("lock").push(format!("wait {paths:?} {app} {reason} {timeout_ms}"));
            (true, "waited".into())
        }
        async fn release(&self) -> String {
            self.0.lock().expect("lock").push("release".into());
            "released".into()
        }
        async fn message(&self, text: String, to: Option<String>, needs_ack: bool) -> (bool, String) {
            self.0.lock().expect("lock").push(format!("message {text} {to:?} {needs_ack}"));
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
        assert_eq!(run("coordination_claim", json!({ "reason": "x" })).await, (false, "Name at least one path, or set app: true.".into()));
        let many: Vec<String> = (0..51).map(|n| format!("f{n}")).collect();
        assert!(!run("coordination_claim", json!({ "paths": many, "reason": "x" })).await.0);
        assert_eq!(run("coordination_ack", json!({ "sequence": 0 })).await, (false, "Give the note's number.".into()));
        assert_eq!(run("coordination_message", json!({ "text": "  " })).await, (false, "A message needs text.".into()));
        assert_eq!(run("coordination_nope", json!({})).await, (false, "Unknown tool: coordination_nope".into()));
        assert!(hooks.0.lock().expect("lock").is_empty(), "nothing reached the hooks");
    }

    #[tokio::test]
    async fn a_wait_is_bounded_and_defaults_to_a_minute() {
        let hooks = Recording::default();
        execute_coordination_tool_with_hooks("coordination_wait", &json!({ "paths": ["a"], "reason": "edit" }), &hooks).await;
        execute_coordination_tool_with_hooks("coordination_wait", &json!({ "paths": ["a"], "reason": "edit", "seconds": 9999 }), &hooks).await;
        execute_coordination_tool_with_hooks("coordination_wait", &json!({ "app": true, "reason": "edit", "seconds": 0.1 }), &hooks).await;
        execute_coordination_tool_with_hooks("coordination_status", &json!({ "since": 7.9 }), &hooks).await;
        execute_coordination_tool_with_hooks("coordination_message", &json!({ "text": "hi", "to": " B ", "needs_ack": true }), &hooks).await;
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

    #[tokio::test]
    async fn claims_and_detects_conflicts() {
        let hub = CoordinationHub::new();
        let claim_res1 = hub
            .claim(
                "session_a",
                &["src/lib.rs".to_string()],
                false,
                "refactoring",
            )
            .await;
        assert!(claim_res1.is_ok());

        // Conflicting claim by session_b
        let claim_res2 = hub
            .claim(
                "session_b",
                &["src/lib.rs".to_string()],
                false,
                "adding docs",
            )
            .await;
        assert!(claim_res2.is_err());
        assert!(
            claim_res2
                .expect_err("second claim must fail")
                .contains("held by session session_a")
        );

        // Release
        let release_msg = hub.release("session_a").await;
        assert!(release_msg.contains("Released 1 claims"));

        // Now session_b can claim
        let claim_res3 = hub
            .claim(
                "session_b",
                &["src/lib.rs".to_string()],
                false,
                "adding docs",
            )
            .await;
        assert!(claim_res3.is_ok());
    }

    #[tokio::test]
    async fn posts_and_acknowledges_notes() {
        let hub = CoordinationHub::new();
        let seq = hub
            .message(
                "worker_1",
                "Finished step 1",
                Some("worker_2".to_string()),
                true,
            )
            .await;
        assert_eq!(seq, 1);

        let status_before = hub.status(None).await;
        assert!(status_before.contains("[needs ack]"));

        hub.ack(seq).await.expect("ack succeeds");
        let status_after = hub.status(None).await;
        assert!(status_after.contains("[acknowledged]"));
    }
}
