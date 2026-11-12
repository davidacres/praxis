//! Praxis's own MCP servers for an ACP session: the issue-tracker tools and the coordination
//! tools. Each session gets a loopback HTTP endpoint (`http://127.0.0.1:<port>/mcp/<token>`),
//! like the Electron app's `trackerMcp.ts` / `coordinationMcp.ts`, and the agent connects to it
//! over MCP's streamable HTTP (stateless, JSON responses). One listener serves every session;
//! the unguessable token in the path (and the matching bearer header) selects the session.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use async_trait::async_trait;
use axum::Router;
use axum::extract::{Path as RoutePath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use praxis_ai::mcp::builtin::{
    COORDINATION_MCP_SERVER_NAME, CoordinationHub, TrackerProvider, execute_coordination_tool, execute_tracker_tool, list_coordination_tools, list_tracker_tools,
};
use praxis_ai::mcp::types::McpToolInfo;
use praxis_host::HostContext;
use praxis_contracts::RustRpcRequest;
use praxis_workflows::types::AgentToolMode;
use serde_json::{Value, json};

use super::{acp_host, runtime};

const TRACKER_SERVER_NAME: &str = "praxis-tracker";

#[derive(Clone)]
enum Kind {
    Tracker { host: HostContext, connection_id: Option<String>, tool_mode: AgentToolMode },
    Coordination,
}

#[derive(Clone)]
struct Session {
    kind: Kind,
    /// The session's issue key: the owner of coordination claims and the tracker permission target.
    issue_key: String,
    dir: std::path::PathBuf,
}

#[derive(Default)]
struct Registry {
    port: u16,
    sessions: HashMap<String, Session>,
    /// `(issue key, server name)` to its registered `(token, url)`, so a session is registered once.
    by_session: HashMap<(String, &'static str), (String, String)>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

fn hub() -> &'static CoordinationHub {
    static HUB: OnceLock<CoordinationHub> = OnceLock::new();
    HUB.get_or_init(CoordinationHub::new)
}

fn lock() -> std::sync::MutexGuard<'static, Registry> {
    registry().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Starts the shared listener on first use and returns its port.
fn ensure_listening() -> Result<u16, String> {
    if lock().port != 0 {
        return Ok(lock().port);
    }
    let listener = runtime::block_on(tokio::net::TcpListener::bind(("127.0.0.1", 0))).map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let app = Router::new().route("/mcp/{token}", post(handle)).with_state(());
    runtime::runtime().spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    lock().port = port;
    Ok(port)
}

fn register(session: Session, name: &'static str) -> Result<Value, String> {
    let key = (session.issue_key.clone(), name);
    let existing = lock().by_session.get(&key).cloned();
    if let Some((token, url)) = existing {
        // A follow-up turn reuses the endpoint, but its permission context may have changed.
        lock().sessions.insert(token.clone(), session);
        return Ok(json!({ "name": name, "url": url, "headers": { "authorization": format!("Bearer {token}") } }));
    }
    let port = ensure_listening()?;
    let token = uuid::Uuid::new_v4().to_string();
    let url = format!("http://127.0.0.1:{port}/mcp/{token}");
    let mut registry = lock();
    registry.sessions.insert(token.clone(), session);
    registry.by_session.insert(key, (token.clone(), url.clone()));
    Ok(json!({ "name": name, "url": url, "headers": { "authorization": format!("Bearer {token}") } }))
}

/// Tears down a session's endpoints (call when the session is deleted).
#[allow(dead_code)]
pub(super) fn dispose_session(issue_key: &str) {
    let mut registry = lock();
    let tokens: Vec<String> = registry.by_session.iter().filter(|((key, _), _)| key == issue_key).map(|(_, (token, _))| token.clone()).collect();
    for token in tokens {
        registry.sessions.remove(&token);
    }
    registry.by_session.retain(|(key, _), _| key != issue_key);
}

pub(super) fn parse_tool_mode(mode: &str) -> AgentToolMode {
    match mode {
        "read-only" => AgentToolMode::ReadOnly,
        "project-only" => AgentToolMode::ProjectOnly,
        _ => AgentToolMode::Full,
    }
}

/// The tracker tools for `issue_key`'s session, or `None` with no tracker bound or in
/// project-only mode (`trackerMcpServerForSession`).
pub(super) fn tracker_server(host: &HostContext, dir: &Path, issue_key: &str, connection_id: Option<&str>, tool_mode: &str) -> Option<Value> {
    if tool_mode == "project-only" {
        return None;
    }
    let session = Session { kind: Kind::Tracker { host: host.clone(), connection_id: connection_id.map(str::to_owned), tool_mode: parse_tool_mode(tool_mode) }, issue_key: issue_key.to_owned(), dir: dir.to_path_buf() };
    register(session, TRACKER_SERVER_NAME).ok()
}

/// The coordination tools: a full-tools session with a working folder can see and claim what other
/// sessions hold (`coordinationMcpServerForSession`).
pub(super) fn coordination_server(dir: &Path, issue_key: &str, working_directory: Option<&str>, tool_mode: &str) -> Option<Value> {
    if std::env::var("PRAXIS_COORDINATION").as_deref() == Ok("off") || tool_mode != "full" || working_directory.is_none_or(|w| w.trim().is_empty()) {
        return None;
    }
    register(Session { kind: Kind::Coordination, issue_key: issue_key.to_owned(), dir: dir.to_path_buf() }, COORDINATION_MCP_SERVER_NAME).ok()
}

// ── tracker backend over the host's own `issue:*` channels ───────────────

pub(super) struct HostTracker {
    host: HostContext,
    connection_id: Option<String>,
}

impl HostTracker {
    pub(super) fn new(host: HostContext, connection_id: Option<String>) -> Self {
        Self { host, connection_id }
    }

    fn call(&self, channel: &str, mut args: Vec<Value>) -> Result<Value, String> {
        args.push(self.connection_id.as_ref().map_or(Value::Null, |id| json!(id)));
        let response = self.host.dispatch_rpc(RustRpcRequest { id: "tracker-mcp".into(), channel: channel.into(), args });
        if response.ok { Ok(response.result.unwrap_or(Value::Null)) } else { Err(response.error.map_or_else(|| "The host returned no error.".to_owned(), |e| e.message)) }
    }
}

#[async_trait]
impl TrackerProvider for HostTracker {
    async fn get_ticket(&self, issue_key: &str) -> Result<Value, String> {
        self.call("issue:get", vec![json!(issue_key)])
    }
    async fn list_transitions(&self, issue_key: &str) -> Result<Vec<Value>, String> {
        let issue = self.call("issue:get", vec![json!(issue_key)])?;
        Ok(issue["transitions"].as_array().cloned().unwrap_or_default())
    }
    async fn add_comment(&self, issue_key: &str, body: &str) -> Result<(), String> {
        self.call("issue:addComment", vec![json!(issue_key), json!(body)]).map(|_| ())
    }
    async fn update_ticket(&self, issue_key: &str, fields: &Value) -> Result<(), String> {
        self.call("issue:update", vec![json!(issue_key), fields.clone()]).map(|_| ())
    }
    async fn transition_ticket(&self, issue_key: &str, transition_id: &str) -> Result<(), String> {
        self.call("issue:transition", vec![json!(issue_key), json!(transition_id)]).map(|_| ())
    }
}

// ── MCP over HTTP ────────────────────────────────────────────────────────

fn tool_json(tool: &McpToolInfo) -> Value {
    json!({ "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema.clone().unwrap_or_else(|| json!({ "type": "object" })) })
}

fn is_write_tool(name: &str) -> bool {
    matches!(name, "tracker_add_comment" | "tracker_update_ticket" | "tracker_transition_ticket")
}

async fn call_tool(session: &Session, name: &str, args: &Value) -> (bool, String) {
    match &session.kind {
        Kind::Tracker { host, connection_id, tool_mode } => {
            let provider = HostTracker { host: host.clone(), connection_id: connection_id.clone() };
            if is_write_tool(name) && *tool_mode != AgentToolMode::ReadOnly {
                // Writing to the tracker needs the person's approval, like any other tool the agent uses.
                let issue = args["issueKey"].as_str().unwrap_or_default().trim();
                if let Some(task) = acp_host::find_active(&session.dir, &session.issue_key) {
                    let detail = format!("The agent wants to use {name} on ticket {issue}.");
                    let decision = task.request_permission(json!({ "kind": "tracker-write", "title": format!("Permission requested: {name}: {detail}"), "name": name })).await;
                    if decision == acp_host::Decision::Deny {
                        return (false, format!("Permission denied for {name}."));
                    }
                }
            }
            match execute_tracker_tool(name, args, *tool_mode, &provider).await {
                Ok(result) => (result.ok, result.content),
                Err(message) => (false, message),
            }
        }
        Kind::Coordination => match execute_coordination_tool(name, args, &session.issue_key, hub()).await {
            Ok(result) => (result.ok, result.content),
            Err(message) => (false, message),
        },
    }
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn respond(session: &Session, request: &Value) -> Option<Value> {
    let method = request["method"].as_str().unwrap_or_default();
    let id = request.get("id").cloned()?;
    Some(match method {
        "initialize" => {
            let version = request["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26");
            let name = if matches!(session.kind, Kind::Coordination) { COORDINATION_MCP_SERVER_NAME } else { TRACKER_SERVER_NAME };
            json!({ "jsonrpc": "2.0", "id": id, "result": { "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": { "name": name, "version": "1.0.0" } } })
        }
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => {
            let tools: Vec<Value> = match &session.kind {
                Kind::Tracker { tool_mode, .. } => list_tracker_tools().iter().filter(|tool| *tool_mode != AgentToolMode::ReadOnly || !is_write_tool(&tool.name)).map(tool_json).collect(),
                Kind::Coordination => list_coordination_tools().iter().map(tool_json).collect(),
            };
            json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } })
        }
        "tools/call" => {
            let name = request["params"]["name"].as_str().unwrap_or_default().to_owned();
            let args = request["params"].get("arguments").cloned().unwrap_or_else(|| json!({}));
            let (ok, content) = call_tool(session, &name, &args).await;
            if let Some(task) = acp_host::find_active(&session.dir, &session.issue_key) {
                task.append(acp_host::evt(if ok { "tool_complete" } else { "tool_failed" }, format!("{name} {}", if ok { "completed" } else { "failed" }), Some(content.chars().take(2000).collect()), Some(json!({ "toolName": name }))), 0);
            }
            json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": content }], "isError": !ok } })
        }
        _ => rpc_error(&id, -32601, "Method not found"),
    })
}

async fn handle(State(()): State<()>, RoutePath(token): RoutePath<String>, headers: HeaderMap, body: String) -> Response {
    let bearer = headers.get("authorization").and_then(|v| v.to_str().ok()).map(|v| v.trim_start_matches("Bearer ").trim().to_owned()).unwrap_or_default();
    let session = lock().sessions.get(&token).cloned();
    let Some(session) = session.filter(|_| bearer.is_empty() || bearer == token) else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };
    let Ok(payload) = serde_json::from_str::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "bad json").into_response();
    };
    let requests: Vec<Value> = if let Some(batch) = payload.as_array() { batch.clone() } else { vec![payload.clone()] };
    let mut replies = Vec::new();
    for request in &requests {
        if let Some(reply) = respond(&session, request).await {
            replies.push(reply);
        }
    }
    if replies.is_empty() {
        return StatusCode::ACCEPTED.into_response();
    }
    let reply = if payload.is_array() { Value::Array(replies) } else { replies.remove(0) };
    ([("content-type", "application/json")], reply.to_string()).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_mode_strings_map_to_the_enum() {
        assert_eq!(parse_tool_mode("read-only"), AgentToolMode::ReadOnly);
        assert_eq!(parse_tool_mode("project-only"), AgentToolMode::ProjectOnly);
        assert_eq!(parse_tool_mode("full"), AgentToolMode::Full);
    }

    #[test]
    fn a_session_without_tools_gets_no_coordination_endpoint() {
        let dir = std::env::temp_dir();
        assert!(coordination_server(&dir, "T-1", Some("/tmp"), "read-only").is_none());
        assert!(coordination_server(&dir, "T-1", None, "full").is_none());
    }

    #[test]
    fn the_endpoint_answers_mcp_requests() {
        let dir = std::env::temp_dir().join("praxis-builtin-mcp-test");
        let server = coordination_server(&dir, "MCP-TEST-1", Some("/tmp"), "full").expect("registered");
        assert_eq!(server["name"], "praxis-coordination");
        let url = server["url"].as_str().expect("url").to_owned();
        let token = server["headers"]["authorization"].as_str().expect("auth").to_owned();
        // Registering again reuses the endpoint.
        assert_eq!(coordination_server(&dir, "MCP-TEST-1", Some("/tmp"), "full").expect("again")["url"], url.as_str());
        let reply = runtime::block_on(async {
            reqwest::Client::new()
                .post(&url)
                .header("authorization", token)
                .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
                .send()
                .await
                .expect("request")
                .json::<Value>()
                .await
                .expect("json")
        });
        let names: Vec<&str> = reply["result"]["tools"].as_array().expect("tools").iter().filter_map(|tool| tool["name"].as_str()).collect();
        assert!(names.contains(&"coordination_status") && names.contains(&"coordination_claim"), "{names:?}");
        dispose_session("MCP-TEST-1");
    }
}
