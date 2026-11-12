//! Hosts a CLI agent (Claude Code, Codex, Copilot, …) as an ACP subprocess for one session.
//! Ports the core of `AcpAgentHost` + `AcpClientWrapper`: it starts the agent, drives one prompt
//! turn, folds the agent's streamed updates into the session record, serves its file requests
//! inside the working folder, relays permission requests to the person, and settles the session.
//!
//! The session record lives in [`super::session_store`]; every change is pushed to the renderer
//! as `ai:sessionChanged`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use praxis_ai::acp::connection::{AcpConnection, AcpSpawn, Incoming};
use praxis_ai::acp::host::is_read_only_shell_command;
use praxis_ai::mcp::builtin::read_only_files::resolve_sandboxed_path;
use praxis_ai::providers::environment::effective_path;
use praxis_ai::providers::provider_limit_error::{
    extract_provider_limit_message, is_limit_notice_reply, is_provider_limit_error,
};
use praxis_ai::providers::registry::resolve_executable;
use praxis_core::unified_diff::create_unified_diff;
use praxis_host::HostContext;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::runtime::runtime;
use super::session_store::{SessionStore, store};
use super::{Result, failure, now};

const CANCEL_GRACE: Duration = Duration::from_secs(3);
const STOP_GRACE: Duration = Duration::from_secs(2);
/// `AGENT_DEFAULTS.timeoutMs`: delivery workflows can run long builds and iterative reviews.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3 * 60 * 60);

const TERMINAL: [&str; 3] = ["completed", "failed", "aborted"];

pub fn is_terminal(state: &str) -> bool {
    TERMINAL.contains(&state)
}

/// A tool-permission answer. Mirrors `PermissionDecision`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Decision {
    AllowOnce,
    AllowAlways,
    Deny,
}

impl Decision {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "allow_once" | "allow" => Some(Self::AllowOnce),
            "allow_always" => Some(Self::AllowAlways),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::AllowOnce => "allow_once",
            Self::AllowAlways => "allow_always",
            Self::Deny => "deny",
        }
    }
}

struct Pending {
    reply: oneshot::Sender<Decision>,
}

/// Everything about a running turn that the update/permission handlers share.
pub struct Task {
    pub(super) key: String,
    pub(super) dir: PathBuf,
    pub(super) host: HostContext,
    pub(super) store: Arc<SessionStore>,
    connection: Mutex<Option<Arc<AcpConnection>>>,
    agent_session_id: Mutex<Option<String>>,
    pub(super) ending: AtomicBool,
    prompt_in_flight: AtomicBool,
    pub(super) allow_all: AtomicBool,
    pub(super) auto_allow_safe: bool,
    pending: Mutex<VecDeque<Pending>>,
    pub(super) message: Mutex<String>,
    pub(super) reasoning: Mutex<String>,
    pub(super) steps: AtomicU32,
    pub(super) started: Instant,
    pub(super) cost_before: Option<Value>,
    active_tool: Mutex<Option<(String, String)>>,
    tool_inputs: Mutex<HashMap<String, Value>>,
    pub(super) done: tokio::sync::Notify,
    pub(super) finished: AtomicBool,
    pub(super) tool_mode: String,
    pub(super) working_directory: PathBuf,
    pub(super) owner_session_id: String,
    /// Milliseconds since `started` of the last update ignored while replaying a resumed session.
    last_replay_ms: std::sync::atomic::AtomicU64,
    /// Wakes an API-provider turn that is waiting on the network when the session is stopped.
    pub(super) cancel: tokio::sync::Notify,
    background: BackgroundState,
}

/// What a turn knows about provider-reported background work (`asyncTasks` extension).
struct BackgroundState {
    /// Identifies this process's tasks in the record (`producerId`); a later turn's never collide.
    producer: String,
    /// Open once the prompt starts: historical replay before it must never produce a live task.
    accepting: AtomicBool,
    /// The connection outlived its turn to observe work the provider is still doing.
    monitoring: AtomicBool,
    tool_names: Mutex<HashMap<String, String>>,
    children: Mutex<HashSet<String>>,
    child_results: Mutex<HashMap<String, String>>,
    monitor: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Default for BackgroundState {
    fn default() -> Self {
        Self {
            producer: super::coordination::epoch_ms().to_string(),
            accepting: AtomicBool::new(false),
            monitoring: AtomicBool::new(false),
            tool_names: Mutex::default(),
            children: Mutex::default(),
            child_results: Mutex::default(),
            monitor: Mutex::default(),
        }
    }
}

const MONITOR_LIMIT: Duration = Duration::from_secs(60 * 60);

/// Connections kept open after their turn ended, to learn how background work finished.
fn background_clients() -> &'static Mutex<Vec<Arc<Task>>> {
    static CLIENTS: OnceLock<Mutex<Vec<Arc<Task>>>> = OnceLock::new();
    CLIENTS.get_or_init(Default::default)
}

fn forget_background_client(task: &Arc<Task>) {
    if let Ok(mut all) = background_clients().lock() {
        all.retain(|item| !Arc::ptr_eq(item, task));
    }
}

impl Task {
    /// This process's background tasks the provider has not finished.
    fn live_background(&self) -> Vec<Value> {
        let Some(record) = self.store.get(&self.key).ok().flatten() else {
            return Vec::new();
        };
        if record["sessionId"] != self.owner_session_id.as_str() {
            return Vec::new();
        }
        record["backgroundTasks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| {
                item["producerId"] == self.background.producer.as_str()
                    && super::background_tasks::is_live(&item["state"])
            })
            .cloned()
            .collect()
    }

    /// Reads background beats out of a `session/update`. Returns true when the notification is
    /// extension or child-session traffic that must not reach the parent transcript.
    fn observe_background(&self, params: &Value) -> bool {
        use super::background_tasks::{
            read_provider_background_update, read_unobserved_background_launch,
        };
        let wire = &params["update"];
        let kind = wire["sessionUpdate"].as_str().unwrap_or_default();
        if let Some(call_id) = wire["toolCallId"].as_str()
            && let Ok(mut names) = self.background.tool_names.lock()
        {
            let is_subagent = |s: &str| {
                let lower = s.to_ascii_lowercase();
                [
                    "start subagent ",
                    "complete subagent ",
                    "interrupt subagent ",
                ]
                .iter()
                .any(|prefix| lower.starts_with(prefix))
            };
            let name = wire["title"]
                .as_str()
                .filter(|t| is_subagent(t))
                .or_else(|| wire["name"].as_str())
                .or_else(|| wire["title"].as_str());
            if let Some(name) = name {
                if names.len() >= 1000
                    && let Some(oldest) = names.keys().next().cloned()
                {
                    names.remove(&oldest);
                }
                names.insert(call_id.to_owned(), name.to_owned());
            }
        }
        let mut observed = wire.clone();
        if let Some(call_id) = wire["toolCallId"].as_str()
            && wire["title"].is_null()
            && let Some(name) = self
                .background
                .tool_names
                .lock()
                .ok()
                .and_then(|names| names.get(call_id).cloned())
        {
            observed["title"] = json!(name);
        }
        let extension = read_provider_background_update(&observed);
        let is_async = matches!(
            kind,
            "async_task_spawned"
                | "async_task_progress"
                | "async_task_state_update"
                | "subagent_spawned"
                | "subagent_state_update"
        );
        let session = params["sessionId"].as_str().unwrap_or_default();
        let is_child = !session.is_empty()
            && self
                .background
                .children
                .lock()
                .is_ok_and(|children| children.contains(session));
        let own = self
            .agent_session_id
            .lock()
            .ok()
            .and_then(|id| id.clone())
            .is_some_and(|id| id == session);
        if (own || is_child) && self.background.accepting.load(Ordering::SeqCst) {
            if kind == "subagent_spawned"
                && let Some(child) = wire["subagentSessionId"].as_str()
                && let Ok(mut children) = self.background.children.lock()
            {
                children.insert(child.to_owned());
            }
            if is_child
                && kind == "agent_message_chunk"
                && wire["content"]["type"] == "text"
                && let Some(text) = wire["content"]["text"].as_str()
                && let Ok(mut results) = self.background.child_results.lock()
            {
                let combined = format!(
                    "{}{text}",
                    results.get(session).cloned().unwrap_or_default()
                );
                let skip = combined.chars().count().saturating_sub(2000);
                results.insert(session.to_owned(), combined.chars().skip(skip).collect());
            }
            if let Some(mut update) = extension.or_else(|| read_unobserved_background_launch(wire))
            {
                if update.detail.is_none()
                    && kind == "subagent_state_update"
                    && let Some(child) = wire["subagentSessionId"].as_str()
                {
                    update.detail = self
                        .background
                        .child_results
                        .lock()
                        .ok()
                        .and_then(|results| results.get(child).cloned());
                }
                self.handle_background_update(update);
            }
        }
        is_async || is_child
    }

    fn handle_background_update(&self, update: super::background_tasks::ProviderBackgroundUpdate) {
        let Some(record) = self.store.get(&self.key).ok().flatten() else {
            return;
        };
        if record["sessionId"] != self.owner_session_id.as_str() {
            return;
        }
        let id = format!("provider:{}:{}", self.background.producer, update.id);
        let previous = record["backgroundTasks"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|item| item["id"] == id.as_str())
            .cloned();
        let Some(state) = update.state.clone().or_else(|| {
            previous
                .as_ref()
                .and_then(|p| p["state"].as_str().map(str::to_owned))
        }) else {
            return;
        };
        let now = now();
        let mut next = json!({
            "id": id, "source": "provider", "producerId": self.background.producer,
            "label": update.label.clone().or_else(|| previous.as_ref().and_then(|p| p["label"].as_str().map(str::to_owned))).unwrap_or_else(|| "Provider background task".into()),
            "state": state, "startedAt": previous.as_ref().and_then(|p| p["startedAt"].as_str().map(str::to_owned)).unwrap_or_else(|| now.clone()), "updatedAt": now,
        });
        if matches!(state.as_str(), "completed" | "failed" | "stopped") {
            next["completedAt"] = json!(now);
        }
        if let Some(detail) = update.detail.clone().or_else(|| {
            previous
                .as_ref()
                .and_then(|p| p["detail"].as_str().map(str::to_owned))
        }) {
            next["detail"] = json!(detail);
        }
        if let Some(call_id) = update.call_id.clone().or_else(|| {
            previous
                .as_ref()
                .and_then(|p| p["callId"].as_str().map(str::to_owned))
        }) {
            next["callId"] = json!(call_id);
        }
        super::shell_services::report_background(self, next);
        if self.background.monitoring.load(Ordering::SeqCst) && self.live_background().is_empty() {
            self.release_background_client();
        }
    }

    /// The provider reported everything finished: the observing connection is no longer needed.
    fn release_background_client(&self) {
        if !self.background.monitoring.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(monitor) = self
            .background
            .monitor
            .lock()
            .ok()
            .and_then(|mut m| m.take())
        {
            monitor.abort();
        }
        let connection = self.connection.lock().ok().and_then(|mut c| c.take());
        if let Ok(mut all) = background_clients().lock() {
            all.retain(|item| !std::ptr::eq(&**item, self));
        }
        if let Some(connection) = connection {
            runtime().spawn(async move { connection.shutdown().await });
        }
    }

    /// The connection ended (or monitoring was abandoned) before the provider said how work finished.
    fn background_connection_lost(&self, detail: &str) {
        for item in self.live_background() {
            let mut lost = item.clone();
            lost["state"] = json!("unknown");
            lost["updatedAt"] = json!(now());
            lost["detail"] = json!(detail);
            super::shell_services::report_background(self, lost);
        }
        if let Some(monitor) = self
            .background
            .monitor
            .lock()
            .ok()
            .and_then(|mut m| m.take())
        {
            monitor.abort();
        }
        self.background.monitoring.store(false, Ordering::SeqCst);
    }
}

/// What a turn starts from: a new session, or a follow-up that tries to resume the agent's own.
pub enum Launch {
    Fresh {
        prompt: String,
        images: Vec<Value>,
    },
    FollowUp {
        prompt: String,
        resumed_prompt: String,
        resume_id: Option<String>,
        images: Vec<Value>,
    },
}

type Tasks = Mutex<HashMap<(PathBuf, String), Arc<Task>>>;

fn tasks() -> &'static Tasks {
    static TASKS: OnceLock<Tasks> = OnceLock::new();
    TASKS.get_or_init(Default::default)
}

pub(super) fn find_task_public(dir: &Path, key: &str) -> Option<Arc<Task>> {
    find_task(dir, key)
}

fn find_task(dir: &Path, key: &str) -> Option<Arc<Task>> {
    tasks()
        .lock()
        .ok()?
        .get(&(dir.to_path_buf(), key.to_owned()))
        .cloned()
}

/// Issue keys with a turn in flight for this profile.
pub fn active_keys(dir: &Path) -> Vec<String> {
    tasks()
        .lock()
        .map(|all| {
            all.keys()
                .filter(|(d, _)| d == dir)
                .map(|(_, key)| key.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a turn is genuinely in flight. A turn that has reached a terminal state is only
/// closing its connection, which must not make "wait for the turn to finish" checks fail.
pub fn is_running(dir: &Path, key: &str) -> bool {
    find_task(dir, key).is_some_and(|task| task.state().is_none_or(|state| !is_terminal(&state)))
}

pub fn has_active_task(dir: &Path, key: &str) -> bool {
    find_task(dir, key).is_some()
}

// ── record changes ───────────────────────────────────────────────────────

/// An event for the transcript. Same shape as `evt()` in the TypeScript host.
pub fn evt(
    kind: &str,
    summary: impl Into<String>,
    detail: Option<String>,
    data: Option<Value>,
) -> Value {
    let mut event = json!({ "timestamp": now(), "type": kind, "summary": summary.into() });
    if let Some(detail) = detail {
        event["detail"] = json!(detail);
    }
    if let Some(data) = data {
        event["data"] = data;
    }
    event
}

impl Task {
    pub(super) fn changed(&self, record: Option<Value>) {
        if let Some(record) = record {
            self.host.events().emit("ai:sessionChanged", Some(record));
        }
    }

    pub(super) fn mutate(&self, persist: bool, change: impl FnOnce(&mut Value)) {
        let record = self.store.mutate(&self.key, persist, change).ok().flatten();
        self.changed(record);
    }

    pub(super) fn state(&self) -> Option<String> {
        self.store
            .get(&self.key)
            .ok()
            .flatten()
            .and_then(|record| record["state"].as_str().map(str::to_owned))
    }

    pub(super) fn set_state(&self, state: &str, reason: Option<&str>) {
        if state == "failed" {
            eprintln!(
                "[session] {} failed: {}",
                self.key,
                reason.unwrap_or("no reason given")
            );
        }
        let reason = reason.map(str::to_owned);
        let state = state.to_owned();
        self.mutate(true, move |record| {
            record["state"] = json!(state);
            match state.as_str() {
                "completed" => {
                    record["lastError"] = Value::Null;
                    record["providerLimitReached"] = Value::Null;
                }
                "failed" | "aborted" => {
                    let limit = reason
                        .as_deref()
                        .filter(|r| is_provider_limit_error(r))
                        .map(str::to_owned)
                        .or_else(|| {
                            record["responseText"]
                                .as_str()
                                .filter(|r| is_provider_limit_error(r))
                                .map(str::to_owned)
                        });
                    if let Some(limit) = limit {
                        record["providerLimitReached"] = json!(true);
                        record["lastError"] =
                            json!(extract_provider_limit_message(&limit).unwrap_or(limit));
                    } else if let Some(reason) = &reason {
                        record["lastError"] = json!(reason);
                    }
                }
                "executing" => {
                    record["lastError"] = Value::Null;
                    record["providerLimitReached"] = Value::Null;
                    if let Some(object) = record.as_object_mut() {
                        object.remove("interruptedByRestart");
                    }
                }
                _ => {}
            }
            if is_terminal(&state) {
                record["completedAt"] = json!(now());
                if let Some(object) = record.as_object_mut() {
                    object.remove("activeTurnProgress");
                }
            } else {
                record["completedAt"] = Value::Null;
            }
        });
    }

    pub(super) fn append(&self, event: Value, steps: u64) {
        self.mutate(true, move |record| {
            if event["type"] == "error"
                && let Some(text) = event["summary"].as_str().or_else(|| event["detail"].as_str()).filter(|t| is_provider_limit_error(t))
            {
                record["providerLimitReached"] = json!(true);
                if record["lastError"].as_str().is_none_or(|e| !is_provider_limit_error(e)) {
                    record["lastError"] = json!(extract_provider_limit_message(text).unwrap_or_else(|| text.to_owned()));
                }
            }
            let signals = praxis_ai::session::skill_usage::detect_skill_uses(std::slice::from_ref(&event));
            if let Some(uses) = praxis_ai::session::skill_usage::merge_detected_skill_uses(Some(&record["detectedSkills"]), &signals).filter(|_| !signals.is_empty()) {
                record["detectedSkills"] = json!(uses);
            }
            let mut event = event;
            // In a multi-AI conversation each reply is attributed to the AI that wrote it.
            if event["type"] == "message" && event["speaker"].is_null() && record["conversation"]["state"] == "running" {
                let speaker = record["conversation"]["participants"].as_array().and_then(|p| p.iter().find(|x| x["id"] == record["conversation"]["currentSpeakerId"])).cloned();
                if let Some(speaker) = speaker {
                    event["speaker"] = json!({ "participantId": speaker["id"], "provider": speaker["provider"], "model": speaker["model"], "displayLabel": speaker["displayLabel"] });
                }
            }
            if let Some(events) = record["events"].as_array_mut() {
                events.push(event);
                let count = events.len();
                record["eventCount"] = json!(count);
            }
            if steps > 0 {
                record["stepCount"] = json!(record["stepCount"].as_u64().unwrap_or(0) + steps);
            }
            record["eventsLoaded"] = json!(true);
        });
    }

    pub(super) fn progress(&self) {
        let active = self.active_tool.lock().ok().and_then(|tool| tool.clone());
        let steps = self.steps.load(Ordering::SeqCst);
        let started = chrono::DateTime::<chrono::Utc>::from(
            std::time::SystemTime::now() - self.started.elapsed(),
        )
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.mutate(false, move |record| {
            let mut progress = json!({ "stepCount": steps, "startedAt": started });
            if let Some((id, name)) = active {
                progress["activeToolCallId"] = json!(id);
                progress["activeToolName"] = json!(name);
            }
            record["activeTurnProgress"] = progress;
        });
    }

    // ── session/update ───────────────────────────────────────────────────

    fn handle_update(&self, update: &Value) {
        match update["sessionUpdate"].as_str().unwrap_or_default() {
            "agent_message_chunk" => {
                let Some(text) = update["content"]["text"]
                    .as_str()
                    .filter(|t| !t.is_empty() && update["content"]["type"] == "text")
                else {
                    return;
                };
                let buffer = {
                    let mut buffer = self
                        .message
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    buffer.push_str(text);
                    buffer.clone()
                };
                self.mutate(false, move |record| {
                    record["responseText"] = json!(buffer);
                    if record["state"] == "planning" {
                        record["planText"] = json!(buffer);
                    }
                });
            }
            "agent_thought_chunk" => {
                let Some(text) = update["content"]["text"]
                    .as_str()
                    .filter(|t| !t.is_empty() && update["content"]["type"] == "text")
                else {
                    return;
                };
                let buffer = {
                    let mut buffer = self
                        .reasoning
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    buffer.push_str(text);
                    buffer.clone()
                };
                self.mutate(false, move |record| record["reasoningText"] = json!(buffer));
            }
            "plan" => {
                let items: Vec<Value> = update["entries"].as_array().into_iter().flatten().map(|e| json!({ "content": e["content"], "status": e["status"], "priority": e["priority"] })).collect();
                self.mutate(true, move |record| record["taskList"] = json!(items));
            }
            "usage_update" => {
                let update = update.clone();
                self.mutate(true, move |record| {
                    if let Some(used) = update["used"].as_u64() {
                        record["contextTokens"] = json!(used);
                    }
                    if let Some(size) = update["size"].as_u64() {
                        record["contextLimit"] = json!(size);
                    }
                    if update["cost"].is_object() {
                        record["cost"] = json!({ "amount": update["cost"]["amount"], "currency": update["cost"]["currency"] });
                    }
                });
            }
            "tool_call" => {
                let status = update["status"].as_str().unwrap_or_default();
                if status == "completed" || status == "failed" {
                    // Some adapters publish a completed notification as the first tool_call.
                    let mut as_update = update.clone();
                    as_update["sessionUpdate"] = json!("tool_call_update");
                    self.handle_update(&as_update);
                    return;
                }
                let id = update["toolCallId"].as_str().unwrap_or_default().to_owned();
                let name = ["name", "title"]
                    .iter()
                    .find_map(|k| update[*k].as_str().filter(|s| !s.is_empty()))
                    .unwrap_or(&id)
                    .to_owned();
                if let Ok(mut tool) = self.active_tool.lock() {
                    *tool = Some((id.clone(), name.clone()));
                }
                self.progress();
                let mut data = json!({ "callId": id, "toolName": name, "kind": map_tool_kind(update["kind"].as_str()) });
                if let Some(title) = update["title"].as_str() {
                    data["argsSummary"] = json!(title);
                }
                if update["rawInput"].is_object() {
                    data["args"] = update["rawInput"].clone();
                }
                self.append(
                    evt(
                        "tool_start",
                        format!("Running tool: {name}"),
                        None,
                        Some(data),
                    ),
                    0,
                );
            }
            "tool_call_update" => self.tool_update(update),
            "available_commands_update" => {
                let commands: Vec<Value> = update["availableCommands"].as_array().into_iter().flatten().map(|c| json!({ "name": c["name"], "description": c["description"], "inputHint": c["input"]["hint"] })).collect();
                self.mutate(true, move |record| {
                    record["acpAvailableCommands"] = json!(commands)
                });
            }
            "current_mode_update" => {
                let mode = update["currentModeId"].clone();
                self.mutate(true, move |record| record["acpCurrentModeId"] = mode);
            }
            _ => {}
        }
    }

    fn tool_update(&self, update: &Value) {
        let status = update["status"].as_str().unwrap_or_default();
        let id = update["toolCallId"].as_str().unwrap_or_default().to_owned();
        if status != "completed" && status != "failed" {
            // A refinement resends only what changed, so merge it over what this call already had.
            if let Some(input) = update["rawInput"].as_object() {
                let mut inputs = self
                    .tool_inputs
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let merged = inputs.entry(id).or_insert_with(|| json!({}));
                for (k, v) in input {
                    merged[k] = v.clone();
                }
            }
            return;
        }
        self.steps.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut tool) = self.active_tool.lock()
            && tool.as_ref().is_some_and(|(active, _)| *active == id)
        {
            *tool = None;
        }
        self.progress();
        let ok = status == "completed";
        let (changes, output) = read_tool_content(&update["content"]);
        let raw_output = if !output.is_empty() {
            output
        } else if let Some(text) = update["rawOutput"].as_str() {
            text.to_owned()
        } else if !update["rawOutput"].is_null() {
            serde_json::to_string_pretty(&update["rawOutput"]).unwrap_or_default()
        } else {
            String::new()
        };
        let diff_text = changes
            .iter()
            .map(|c| c["diff"].as_str().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        let detail = Some(diff_text.trim().to_owned())
            .filter(|d| !d.is_empty())
            .or_else(|| Some(raw_output.clone()).filter(|r| !r.is_empty()));
        let streamed = self
            .tool_inputs
            .lock()
            .ok()
            .and_then(|mut inputs| inputs.remove(&id));
        let final_input = update["rawInput"]
            .as_object()
            .map(|o| Value::Object(o.clone()));
        let args = match (streamed, final_input) {
            (None, None) => None,
            (a, b) => {
                let mut merged = a.unwrap_or_else(|| json!({}));
                if let Some(Value::Object(b)) = b {
                    for (k, v) in b {
                        merged[k] = v;
                    }
                }
                Some(merged)
            }
        };
        let name = ["name", "title"]
            .iter()
            .find_map(|k| update[*k].as_str())
            .unwrap_or(&id)
            .to_owned();
        let mut data = json!({
            "callId": id,
            "kind": if changes.is_empty() { map_tool_kind(update["kind"].as_str()) } else { "write" },
            "ok": ok
        });
        if let Some(name) = update["name"].as_str().or_else(|| update["title"].as_str()) {
            data["toolName"] = json!(name);
        }
        if let Some(args) = args {
            data["args"] = args;
        }
        if !changes.is_empty() {
            data["diff"] = changes[0]["diff"].clone();
            data["fileChanges"] = json!(changes);
        }
        if !raw_output.is_empty() {
            data["output"] = json!(if raw_output.chars().count() > 20_000 {
                format!(
                    "{}\n… [output truncated]",
                    raw_output.chars().take(20_000).collect::<String>()
                )
            } else {
                raw_output
            });
        }
        let summary = format!("Tool {}: {name}", if ok { "completed" } else { "failed" });
        self.append(
            evt(
                "tool_complete",
                summary,
                detail.map(|d| d.chars().take(2000).collect()),
                Some(data),
            ),
            1,
        );
    }

    // ── permissions ──────────────────────────────────────────────────────

    pub(super) async fn request_permission(&self, request: Value) -> Decision {
        if self.ending.load(Ordering::SeqCst) {
            return Decision::Deny;
        }
        let kind = request["kind"].as_str();
        let title = request["title"].as_str().unwrap_or_default().to_owned();
        let command = if matches!(kind, None | Some("execute" | "other")) {
            shell_command_of(&request["rawInput"])
        } else {
            None
        };
        // A refused tool ends Copilot's whole turn, so a command that can only look is not refused.
        let read_only_kind = matches!(kind, Some("read" | "search" | "think" | "fetch"))
            || command.as_deref().is_some_and(is_read_only_shell_command);
        if self.tool_mode == "project-only" || (self.tool_mode == "read-only" && !read_only_kind) {
            let shown = command
                .as_deref()
                .map(|c| {
                    format!(
                        " ({})",
                        if c.chars().count() > 200 {
                            format!("{}…", c.chars().take(200).collect::<String>())
                        } else {
                            c.to_owned()
                        }
                    )
                })
                .unwrap_or_default();
            self.append(
                evt(
                    "warning",
                    format!("Blocked by read-only tools: {title}{shown}"),
                    None,
                    None,
                ),
                0,
            );
            return Decision::Deny;
        }
        if self.allow_all.load(Ordering::SeqCst) {
            return Decision::AllowAlways;
        }
        let text = format!("{} {title}", kind.unwrap_or_default()).to_lowercase();
        let safe = if self.tool_mode == "read-only" {
            read_only_kind
        } else {
            text.split(|c: char| !c.is_alphanumeric())
                .any(|w| w == "read" || w == "list")
        };
        if self.auto_allow_safe && safe {
            return Decision::AllowAlways;
        }
        let (reply, answer) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.push_back(Pending { reply });
        }
        self.set_state("awaiting_approval", None);
        let action = permission_action(&request);
        let mut data = None;
        if let Some(name) = permission_tool_name(
            request["name"].as_str(),
            request["toolCallId"].as_str().unwrap_or_default(),
        ) {
            data = Some(json!({ "toolName": name }));
        }
        // API-session tools describe their own request (`description` and `detail`).
        let (summary, detail) = match request["description"].as_str() {
            Some(description) => (
                description.to_owned(),
                request["detail"].as_str().map(str::to_owned),
            ),
            None => (
                format!("Approval needed: {action}"),
                Some(format!("The agent is requesting permission to {action}.")),
            ),
        };
        self.append(evt("permission_requested", summary, detail, data), 0);
        answer.await.unwrap_or(Decision::Deny)
    }

    fn respond_to_permission(&self, decision: Decision) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.is_empty() {
            return;
        }
        if decision == Decision::AllowAlways {
            self.allow_all.store(true, Ordering::SeqCst);
            let all: Vec<Pending> = pending.drain(..).collect();
            let count = all.len();
            drop(pending);
            for waiting in all {
                let _ = waiting.reply.send(decision);
            }
            self.append(
                evt(
                    "permission_completed",
                    format!(
                        "Permission: {} ({count} queued request{})",
                        decision.label(),
                        if count == 1 { "" } else { "s" }
                    ),
                    None,
                    None,
                ),
                0,
            );
            self.set_state("executing", None);
            return;
        }
        let Some(first) = pending.pop_front() else {
            return;
        };
        let remaining = pending.len();
        drop(pending);
        let _ = first.reply.send(decision);
        self.append(
            evt(
                "permission_completed",
                format!("Permission: {}", decision.label()),
                None,
                None,
            ),
            0,
        );
        self.set_state(
            if remaining > 0 {
                "awaiting_approval"
            } else {
                "executing"
            },
            None,
        );
    }
}

fn map_tool_kind(kind: Option<&str>) -> &'static str {
    match kind {
        Some("edit" | "delete" | "move") => "write",
        Some("execute") => "shell",
        Some("read") => "read",
        Some("search") => "search",
        _ => "other",
    }
}

/// The command a shell tool would run: `command`/`cmd`, as a string or an argv array.
fn shell_command_of(raw_input: &Value) -> Option<String> {
    let value = raw_input.get("command").or_else(|| raw_input.get("cmd"))?;
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    let parts: Vec<&str> = value
        .as_array()?
        .iter()
        .map(Value::as_str)
        .collect::<Option<_>>()?;
    // Codex sends ["bash", "-lc", "<script>"].
    if parts.len() == 3
        && matches!(parts[0].rsplit('/').next(), Some("sh" | "bash" | "zsh"))
        && matches!(parts[1], "-c" | "-lc")
    {
        return Some(parts[2].to_owned());
    }
    Some(
        parts
            .iter()
            .map(|p| {
                if !p.is_empty()
                    && p.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c))
                {
                    (*p).to_owned()
                } else {
                    format!("'{}'", p.replace('\'', "'\\''"))
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn permission_action(request: &Value) -> String {
    let title = request["title"].as_str().unwrap_or_default().trim();
    match request["kind"].as_str().map(str::to_lowercase).as_deref() {
        Some("read") => "read a file or project resource".into(),
        Some("edit") => "edit a file".into(),
        Some("delete") => "delete a file or resource".into(),
        Some("move") => "move a file or resource".into(),
        Some("search") => "search the project".into(),
        Some("execute") => "execute a command or tool".into(),
        Some("fetch") => "fetch content from the internet".into(),
        Some("switch_mode") => "switch the agent mode".into(),
        Some("think") => "perform an extended reasoning step".into(),
        Some("browser-navigate") => {
            let mut chars = title.chars();
            chars.next().map_or_else(
                || "open a site in the in-app browser".into(),
                |first| first.to_lowercase().collect::<String>() + chars.as_str(),
            )
        }
        _ => request["name"]
            .as_str()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map_or_else(|| "perform an agent action".into(), |n| format!("run {n}")),
    }
}

fn permission_tool_name(value: Option<&str>, tool_call_id: &str) -> Option<String> {
    let name = value?.trim();
    let opaque = name.is_empty()
        || name == tool_call_id
        || (name.len() >= 20
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        || (name.len() >= 36 && name.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    let pathlike = name.contains('/')
        || name.contains('\\')
        || name.starts_with(['.', '~'])
        || name.chars().nth(1) == Some(':');
    (!opaque && !pathlike).then(|| name.to_owned())
}

/// Maps a decision onto whichever ACP option the agent offered. A denial never falls back to an
/// allow-only list.
fn pick_option_id(decision: Decision, options: &[Value]) -> Option<String> {
    let preferred: [&str; 2] = match decision {
        Decision::AllowOnce => ["allow_once", "allow_always"],
        Decision::AllowAlways => ["allow_always", "allow_once"],
        Decision::Deny => ["reject_once", "reject_always"],
    };
    let known = ["allow_once", "allow_always", "reject_once", "reject_always"];
    for kind in preferred {
        let found = options.iter().find(|o| {
            let option_kind = o["kind"].as_str().unwrap_or_default();
            let id = o["optionId"].as_str().unwrap_or_default();
            option_kind == kind
                || (!known.contains(&option_kind) && (id == kind || id == kind.replace('_', "-")))
        });
        if let Some(found) = found {
            return found["optionId"].as_str().map(str::to_owned);
        }
    }
    if decision == Decision::Deny {
        None
    } else {
        options
            .first()
            .and_then(|o| o["optionId"].as_str())
            .map(str::to_owned)
    }
}

/// Diff blocks and text output out of an ACP tool-call content array.
fn read_tool_content(content: &Value) -> (Vec<Value>, String) {
    let (mut changes, mut text) = (Vec::new(), Vec::new());
    for block in content.as_array().into_iter().flatten() {
        if block["type"] == "diff" {
            let (old, new) = (
                block["oldText"].as_str().unwrap_or_default(),
                block["newText"].as_str().unwrap_or_default(),
            );
            let path = block["path"].as_str().unwrap_or_default();
            changes.push(json!({ "path": path, "oldText": old, "newText": new, "diff": create_unified_diff(path, old, new, 3) }));
        } else if block["type"] == "content" && block["content"]["type"] == "text" {
            text.push(
                block["content"]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            );
        }
    }
    (changes, text.join("\n").trim().to_owned())
}

// ── agent → client requests ──────────────────────────────────────────────

fn read_file(task: &Task, params: &Value) -> std::result::Result<Value, String> {
    if task.tool_mode == "project-only" {
        return Err("File reads are unavailable without a project workspace folder.".into());
    }
    let path = resolve_sandboxed_path(
        &task.working_directory,
        params["path"].as_str().unwrap_or_default(),
    )?;
    let mut content =
        std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let (line, limit) = (params["line"].as_u64(), params["limit"].as_u64());
    if line.is_some() || limit.is_some() {
        let lines: Vec<&str> = content.split('\n').collect();
        let start = line
            .map_or(0, |l| l.saturating_sub(1) as usize)
            .min(lines.len());
        let end = limit.map_or(lines.len(), |l| (start + l as usize).min(lines.len()));
        content = lines[start..end].join("\n");
    }
    Ok(json!({ "content": content }))
}

async fn write_file(task: &Task, params: &Value) -> std::result::Result<Value, String> {
    use super::coordination::{Decision, gate_for};
    use praxis_ai::coordination::{Lifetime, refusal_for_agent};
    if matches!(task.tool_mode.as_str(), "read-only" | "project-only") {
        return Err("File writes are unavailable in read-only tool mode.".into());
    }
    let requested = params["path"].as_str().unwrap_or_default();
    let path = resolve_sandboxed_path(&task.working_directory, requested)?;
    // Owned before it is written: a file another session holds is not touched, and the agent is
    // told who has it instead of retrying blind.
    let grant = match gate_for(
        &task.key,
        &task.working_directory,
        praxis_ai::coordination::Coverage::Cooperative,
    ) {
        Some(gate) => match gate
            .acquire(
                vec![gate.file_item(&path, false)?],
                &format!("write {requested}"),
                Lifetime::Tool,
            )
            .await
        {
            Decision::Granted(grant) => Some(grant),
            Decision::Refused(reason) => {
                return Err(refusal_for_agent(&reason, Some("coordination_wait")));
            }
        },
        None => None,
    };
    let written = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, params["content"].as_str().unwrap_or_default())
            .map_err(|e| format!("{}: {e}", path.display()))
    })();
    if let Some(grant) = grant {
        grant.release(None).await;
    }
    written?;
    Ok(json!({}))
}

async fn serve(
    task: Arc<Task>,
    connection: Arc<AcpConnection>,
    mut incoming: tokio::sync::mpsc::UnboundedReceiver<Incoming>,
) {
    while let Some(message) = incoming.recv().await {
        match message {
            Incoming::Notification { method, params } => {
                if method != "session/update" {
                    continue;
                }
                // Provider background work is observed on its own gate: it outlives the prompt.
                if !task.background.accepting.load(Ordering::SeqCst) {
                    task.last_replay_ms
                        .store(task.started.elapsed().as_millis() as u64, Ordering::SeqCst);
                }
                if task.observe_background(&params) {
                    continue;
                }
                // A resumed session replays history; only the live prompt's updates count.
                let current = task.agent_session_id.lock().ok().and_then(|id| id.clone());
                if current
                    .as_deref()
                    .is_some_and(|id| params["sessionId"] != id)
                    || !task.prompt_in_flight.load(Ordering::SeqCst)
                    || task.ending.load(Ordering::SeqCst)
                {
                    task.last_replay_ms
                        .store(task.started.elapsed().as_millis() as u64, Ordering::SeqCst);
                    continue;
                }
                task.handle_update(&params["update"]);
            }
            Incoming::Request { id, method, params } => {
                let task = Arc::clone(&task);
                let connection = Arc::clone(&connection);
                tokio::spawn(async move {
                    let reply = match method.as_str() {
                        "fs/read_text_file" => read_file(&task, &params),
                        "fs/write_text_file" => write_file(&task, &params).await,
                        "session/request_permission" => {
                            let call = &params["toolCall"];
                            let request = json!({ "toolCallId": call["toolCallId"], "title": call["title"].as_str().unwrap_or_else(|| call["toolCallId"].as_str().unwrap_or_default()), "name": call["name"], "kind": call["kind"], "rawInput": call["rawInput"] });
                            let decision = task.request_permission(request).await;
                            let options = params["options"].as_array().cloned().unwrap_or_default();
                            Ok(match pick_option_id(decision, &options) {
                                Some(option_id) => {
                                    json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
                                }
                                None => json!({ "outcome": { "outcome": "cancelled" } }),
                            })
                        }
                        other => Err(format!("Method not found: {other}")),
                    };
                    let _ = match reply {
                        Ok(result) => connection.respond(&id, result).await,
                        Err(message) => {
                            connection
                                .respond_error(
                                    &id,
                                    if method.starts_with("fs/") {
                                        -32603
                                    } else {
                                        -32601
                                    },
                                    &message,
                                )
                                .await
                        }
                    };
                });
            }
            Incoming::Closed => break,
        }
    }
    if task.background.monitoring.load(Ordering::SeqCst) {
        task.background_connection_lost("The provider connection ended before a completion result arrived. The outcome is unknown.");
        forget_background_client(&task);
    }
}

// ── starting a task ──────────────────────────────────────────────────────

/// Everything needed to launch one ACP session.
pub struct StartTask {
    pub issue: Value,
    pub task: Value,
    pub provider: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub working_directory: Option<String>,
    pub tool_mode: String,
    pub permission_mode: Option<String>,
    pub auto_approve: bool,
    pub command: String,
    pub args: Vec<String>,
    pub mcp_servers: Vec<Value>,
    /// Images sent with the first prompt (a reconstructed team-chat turn starts a fresh session).
    pub images: Vec<Value>,
}

/// Creates the session record, then runs the agent in the background. Returns the session id.
pub fn start_task(host: &HostContext, dir: &Path, request: StartTask) -> Result<String> {
    let key = request.issue["key"].as_str().unwrap_or_default().to_owned();
    if has_active_task(dir, &key) {
        abort_task(host, dir, &key);
    }
    let sessions = store(dir);
    let session_id = uuid::Uuid::new_v4().to_string();
    let started_at = now();
    let mode = request.task["sessionMode"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| match request.task["kind"].as_str() {
            Some("analysis") => "analysis".into(),
            Some("review") => "review".into(),
            _ => "chat".into(),
        });
    let working = request
        .working_directory
        .as_deref()
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .map(str::to_owned);
    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    let cost_before = sessions
        .get(&key)?
        .and_then(|r| Some(r["cost"].clone()).filter(|c| !c.is_null()));
    let mut record = json!({
        "issueKey": key, "sessionId": session_id, "provider": request.provider, "toolMode": request.tool_mode,
        "state": "not_started", "taskDefinition": request.task, "purpose": super::session_handover::purpose_from_task(&request.task, &key, None),
        "handoverBrief": super::session_handover::empty_brief(&started_at),
        "runtimeEpochs": [{ "id": super::session_handover::new_epoch_id(), "provider": request.provider, "startedAt": started_at, "reason": "started" }],
        "mode": mode, "events": [], "eventsLoaded": true, "eventCount": 0, "stepCount": 0, "startedAt": started_at,
        "reasoningEffort": request.reasoning_effort.clone().unwrap_or_else(|| "medium".into())
    });
    if let Some(model) = &model {
        record["model"] = json!(model);
        record["runtimeEpochs"][0]["model"] = json!(model);
    }
    if let Some(working) = &working {
        record["workingDirectory"] = json!(working);
    }
    if request.auto_approve {
        record["autoApprovePermissions"] = json!(true);
    }
    if let Some(mode) = &request.permission_mode {
        record["permissionMode"] = json!(mode);
    }
    sessions.put(&key, record.clone())?;

    let working_directory = working
        .clone()
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    let task = Arc::new(Task {
        key: key.clone(),
        dir: dir.to_path_buf(),
        host: host.clone(),
        store: Arc::clone(&sessions),
        connection: Mutex::new(None),
        agent_session_id: Mutex::new(None),
        ending: AtomicBool::new(false),
        prompt_in_flight: AtomicBool::new(false),
        allow_all: AtomicBool::new(request.auto_approve),
        auto_allow_safe: request.permission_mode.as_deref() == Some("auto"),
        pending: Mutex::default(),
        message: Mutex::default(),
        reasoning: Mutex::default(),
        steps: AtomicU32::new(0),
        started: Instant::now(),
        cost_before,
        active_tool: Mutex::default(),
        tool_inputs: Mutex::default(),
        done: tokio::sync::Notify::new(),
        finished: AtomicBool::new(false),
        tool_mode: request.tool_mode.clone(),
        working_directory,
        owner_session_id: session_id.clone(),
        last_replay_ms: std::sync::atomic::AtomicU64::new(0),
        cancel: tokio::sync::Notify::new(),
        background: Default::default(),
    });
    if let Ok(mut all) = tasks().lock() {
        all.insert((dir.to_path_buf(), key.clone()), Arc::clone(&task));
    }
    task.changed(Some(record));
    task.set_state("planning", None);
    task.append(
        evt("session_start", "CLI agent session started", None, None),
        0,
    );

    let timeout = request.task["timeoutMs"]
        .as_u64()
        .map_or(DEFAULT_TIMEOUT, Duration::from_millis);
    let prompt_text = praxis_ai::session::prompt::acp_launch_prompt(
        &request.task,
        &request.issue,
        &request.tool_mode,
        request
            .mcp_servers
            .iter()
            .any(|s| s["name"] == "praxis-browser"),
        request
            .mcp_servers
            .iter()
            .any(|s| s["name"] == praxis_ai::session::prompt::code_intelligence_server_name()),
        request.permission_mode.as_deref() == Some("autopilot"),
    );
    let runner = Arc::clone(&task);
    let launch = Launch::Fresh {
        prompt: prompt_text,
        images: request.images.clone(),
    };
    runtime().spawn(async move {
        let outcome =
            tokio::time::timeout(timeout, run_turn(Arc::clone(&runner), request, launch)).await;
        if outcome.is_err() {
            stop(
                &runner,
                "failed",
                evt(
                    "error",
                    format!("Task stopped after timing out at {}s.", timeout.as_secs()),
                    None,
                    None,
                ),
            )
            .await;
        }
        finish(&runner).await;
    });
    Ok(session_id)
}

async fn finish(task: &Arc<Task>) {
    task.finished.store(true, Ordering::SeqCst);
    task.done.notify_waiters();
    // Work the provider reported as still running keeps the connection open to hear how it ended.
    let observing = !task.ending.load(Ordering::SeqCst)
        && task.connection.lock().is_ok_and(|c| c.is_some())
        && !task.live_background().is_empty();
    if observing {
        task.background.monitoring.store(true, Ordering::SeqCst);
        if let Ok(mut all) = background_clients().lock() {
            all.push(Arc::clone(task));
        }
        let watched = Arc::clone(task);
        let handle = runtime().spawn(async move {
            tokio::time::sleep(MONITOR_LIMIT).await;
            // Detach rather than abort: this task is the monitor and still has to close the connection.
            let _ = watched.background.monitor.lock().ok().and_then(|mut m| m.take());
            watched.background_connection_lost("Background monitoring reached its one-hour limit. Completion has not been confirmed.");
            release_connection(&watched).await;
            forget_background_client(&watched);
        });
        if let Ok(mut monitor) = task.background.monitor.lock() {
            *monitor = Some(handle);
        }
    } else {
        release_connection(task).await;
    }
    let _ = task.store.flush();
    if let Ok(mut all) = tasks().lock()
        && all
            .get(&(task.dir.clone(), task.key.clone()))
            .is_some_and(|current| Arc::ptr_eq(current, task))
    {
        all.remove(&(task.dir.clone(), task.key.clone()));
    }
    // The turn is over: what its tools still hold at the broker is released, and its waits end.
    if find_task(&task.dir, &task.key).is_none() {
        super::coordination::end_coordinated_turn(&task.key);
    }
}

async fn release_connection(task: &Arc<Task>) {
    let connection = task.connection.lock().ok().and_then(|mut c| c.take());
    if let Some(connection) = connection {
        connection.shutdown().await;
    }
}

fn fail_turn(task: &Task, message: String) {
    let state = task.state().unwrap_or_default();
    if is_terminal(&state) {
        return;
    }
    let limit = [
        Some(message.clone()),
        Some(task.message.lock().map(|m| m.clone()).unwrap_or_default()),
        task.store
            .get(&task.key)
            .ok()
            .flatten()
            .and_then(|r| r["responseText"].as_str().map(str::to_owned)),
    ]
    .into_iter()
    .flatten()
    .find(|text| is_provider_limit_error(text));
    let shown = limit
        .as_deref()
        .map(|l| extract_provider_limit_message(l).unwrap_or_else(|| l.to_owned()))
        .unwrap_or(message);
    task.set_state("failed", Some(&shown));
    task.append(evt("error", shown, None, None), 0);
}

async fn run_turn(task: Arc<Task>, request: StartTask, launch: Launch) {
    match drive(&task, &request, launch).await {
        Ok(()) => {}
        Err(message) => fail_turn(&task, message),
    }
}

async fn drive(
    task: &Arc<Task>,
    request: &StartTask,
    launch: Launch,
) -> std::result::Result<(), String> {
    let resolved = resolve_executable(&request.command, effective_path()).ok_or_else(|| {
        format!(
            "Failed to start '{}': spawn {} ENOENT",
            request.command, request.command
        )
    })?;
    let (connection, incoming) = AcpConnection::spawn(AcpSpawn {
        command: resolved.to_string_lossy().into_owned(),
        args: request.args.clone(),
        cwd: Some(task.working_directory.to_string_lossy().into_owned()).filter(|c| !c.is_empty()),
        env: vec![("PATH".into(), effective_path().to_owned())],
    })
    .await?;
    let connection = Arc::new(connection);
    if let Ok(mut slot) = task.connection.lock() {
        *slot = Some(Arc::clone(&connection));
    }
    tokio::spawn(serve(Arc::clone(task), Arc::clone(&connection), incoming));

    let init = connection
        .request("initialize", json!({
            "protocolVersion": 1,
            "clientCapabilities": { "_meta": super::background_tasks::client_meta(), "fs": { "readTextFile": request.tool_mode != "project-only", "writeTextFile": request.tool_mode == "full" } },
            "clientInfo": { "name": "praxis", "version": "0.0.0" }
        }))
        .await
        .map_err(|e| with_stderr(&e.to_string()))?;
    let capabilities = init["agentCapabilities"].clone();
    let http_supported = capabilities["mcpCapabilities"]["http"] == true;
    let servers: Vec<Value> = request
        .mcp_servers
        .iter()
        .filter_map(|server| mcp_for_session(server, http_supported))
        .collect();
    if !capabilities.is_null() {
        let manifest = json!({
            "protocol": "acp", "sessionResume": capabilities["sessionCapabilities"]["resume"].is_object() || capabilities["sessionCapabilities"]["resume"] == true,
            "sessionLoad": capabilities["loadSession"] == true, "sessionClose": capabilities["sessionCapabilities"]["close"].is_object() || capabilities["sessionCapabilities"]["close"] == true,
            "mcpHttp": http_supported
        });
        task.mutate(true, move |record| {
            record["providerCapabilities"] = manifest
        });
    }
    if task.ending.load(Ordering::SeqCst) {
        return Ok(());
    }

    // A follow-up first tries the agent's own session (`session/load` takes MCP servers, `session/resume`
    // does not); if that is unavailable or fails, a new session is started with a reconstructed prompt.
    let mut resumed = false;
    let mut options: Vec<Value> = Vec::new();
    let mut session = Value::Null;
    let mut agent_session = String::new();
    if let Launch::FollowUp {
        resume_id: Some(resume_id),
        ..
    } = &launch
    {
        let can_resume = capabilities["sessionCapabilities"]["resume"].is_object()
            || capabilities["sessionCapabilities"]["resume"] == true;
        let can_load = capabilities["loadSession"] == true;
        let cwd = task.working_directory.to_string_lossy().into_owned();
        let attempt = if can_load && (!servers.is_empty() || !can_resume) {
            Some(connection.request("session/load", json!({ "sessionId": resume_id, "cwd": cwd, "mcpServers": servers, "additionalDirectories": [] })).await)
        } else if can_resume {
            Some(
                connection
                    .request(
                        "session/resume",
                        json!({ "sessionId": resume_id, "cwd": cwd, "additionalDirectories": [] }),
                    )
                    .await,
            )
        } else {
            None
        };
        if let Some(Ok(response)) = attempt {
            resumed = true;
            agent_session = resume_id.clone();
            options = response["configOptions"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if let Ok(mut slot) = task.agent_session_id.lock() {
                *slot = Some(agent_session.clone());
            }
        }
    }
    if !resumed {
        session = connection
            .request(
                "session/new",
                json!({ "cwd": task.working_directory, "mcpServers": servers }),
            )
            .await
            .map_err(|e| with_stderr(&e.to_string()))?;
        agent_session = session["sessionId"]
            .as_str()
            .ok_or("The agent did not return a session id.")?
            .to_owned();
        options = session["configOptions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if let Ok(mut slot) = task.agent_session_id.lock() {
            *slot = Some(agent_session.clone());
        }
    }
    {
        let id = agent_session.clone();
        task.mutate(true, move |record| record["runtimeSessionId"] = json!(id));
    }
    if let Some(model) = request.model.as_deref().filter(|m| !m.is_empty()) {
        // Not every agent exposes a model option; the prompt still runs.
        let _ = connection
            .request(
                "session/set_config_option",
                json!({ "sessionId": agent_session, "configId": "model", "value": model }),
            )
            .await;
    }
    // The reasoning effort rides the agent's `thought_level` option; agents without one keep their default.
    if let Some(effort) = request
        .reasoning_effort
        .as_deref()
        .filter(|e| !e.is_empty())
    {
        let option = options
            .iter()
            .find(|o| o["category"] == "thought_level" || o["id"] == "effort")
            .cloned();
        if let Some(option) = option.filter(|o| o["type"] == "select") {
            let choices: Vec<Value> = option["options"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|e| {
                    if e.get("group").is_some() {
                        e["options"].as_array().cloned().unwrap_or_default()
                    } else {
                        vec![e.clone()]
                    }
                })
                .collect();
            let preferred: Vec<&str> = if effort == "off" {
                vec!["off", "none", "minimal", "default"]
            } else {
                vec![effort]
            };
            let value = preferred.iter().find_map(|candidate| {
                choices
                    .iter()
                    .find(|c| {
                        c["value"]
                            .as_str()
                            .is_some_and(|v| v.eq_ignore_ascii_case(candidate))
                            || c["name"]
                                .as_str()
                                .is_some_and(|n| n.eq_ignore_ascii_case(candidate))
                    })
                    .and_then(|c| c["value"].as_str().map(str::to_owned))
            });
            if let Some(value) = value {
                let _ = connection.request("session/set_config_option", json!({ "sessionId": agent_session, "configId": option["id"], "value": value })).await;
            }
        }
    }
    if let Some(modes) = session["modes"].as_object() {
        let current = modes.get("currentModeId").cloned().unwrap_or(Value::Null);
        let available: Vec<Value> = modes
            .get("availableModes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|m| json!({ "id": m["id"], "name": m["name"], "description": m["description"] }))
            .collect();
        task.mutate(true, move |record| {
            record["acpCurrentModeId"] = current;
            record["acpAvailableModes"] = json!(available);
        });
    }
    let agent_model = request
        .model
        .is_none()
        .then(|| {
            options
                .iter()
                .find(|o| o["category"] == "model" || o["id"] == "model")
                .and_then(|o| o["currentValue"].as_str().map(str::to_owned))
        })
        .flatten();
    if task.ending.load(Ordering::SeqCst) {
        return Ok(());
    }

    let (text, images, follow_up) = match launch {
        Launch::Fresh { prompt, images } => (prompt, images, false),
        Launch::FollowUp {
            prompt,
            resumed_prompt,
            images,
            ..
        } => (if resumed { resumed_prompt } else { prompt }, images, true),
    };
    if text.chars().count() > 1_000_000 {
        return Err(format!(
            "ACP prompt is too large ({} characters; maximum 1000000). Shorten the message or attached context before retrying.",
            text.chars().count()
        ));
    }
    // Replay and session-setup notifications arrive before the prompt gate opens; let the ones already
    // in flight drain so history is never mistaken for output of this turn. A fresh session can also
    // send state before its first prompt (a provider's task log), which must not become live tasks.
    {
        let deadline = Instant::now() + Duration::from_millis(if resumed { 500 } else { 150 });
        if resumed {
            task.last_replay_ms
                .store(task.started.elapsed().as_millis() as u64, Ordering::SeqCst);
        }
        while Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
            if task.started.elapsed().as_millis() as u64
                - task.last_replay_ms.load(Ordering::SeqCst)
                >= 50
            {
                break;
            }
        }
    }
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    blocks.extend(images.iter().map(|image| json!({ "type": "image", "data": image["dataBase64"], "mimeType": image["mimeType"] })));
    task.background.accepting.store(true, Ordering::SeqCst);
    task.prompt_in_flight.store(true, Ordering::SeqCst);
    let reply = connection
        .request(
            "session/prompt",
            json!({ "sessionId": agent_session, "prompt": blocks }),
        )
        .await;
    // The reply can overtake the last streamed chunks by a hair; let them land before the gate closes.
    tokio::time::sleep(Duration::from_millis(30)).await;
    task.prompt_in_flight.store(false, Ordering::SeqCst);
    let response = reply.map_err(|e| with_stderr(&e.to_string()))?;
    settle(
        task,
        &response,
        request.model.as_deref().or(agent_model.as_deref()),
        follow_up,
    );
    Ok(())
}

/// Appends the agent's stderr tail to an error so the person sees why it failed.
fn with_stderr(message: &str) -> String {
    message.to_owned()
}

fn mcp_for_session(server: &Value, http_supported: bool) -> Option<Value> {
    if server["command"].is_string() {
        let env: Vec<Value> = server["env"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect();
        return Some(
            json!({ "name": server["name"], "command": server["command"], "args": server["args"].as_array().cloned().unwrap_or_default(), "env": env }),
        );
    }
    http_supported.then(|| {
        let headers: Vec<Value> = server["headers"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect();
        json!({ "type": "http", "name": server["name"], "url": server["url"], "headers": headers })
    })
}

/// Records the finished turn: the reply, telemetry, and the terminal state.
fn settle(task: &Arc<Task>, response: &Value, fallback_model: Option<&str>, follow_up: bool) {
    if task.ending.load(Ordering::SeqCst) {
        return;
    }
    let buffer = task.message.lock().map(|m| m.clone()).unwrap_or_default();
    let reasoning = task
        .reasoning
        .lock()
        .map(|m| m.trim().to_owned())
        .unwrap_or_default();
    {
        let text = buffer.clone();
        task.mutate(true, move |record| record["responseText"] = json!(text));
    }
    let stop = response["stopReason"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    // A turn that ended on a provider limit (or replied with a limit notice) fails; the notice is
    // not shown as an assistant bubble.
    let limit_text = if is_limit_notice_reply(&buffer) {
        Some(buffer.as_str())
    } else if is_provider_limit_error(&stop) {
        Some(stop.as_str())
    } else {
        None
    };
    if let Some(limit) = limit_text {
        let notice = extract_provider_limit_message(limit).unwrap_or_else(|| limit.to_owned());
        task.set_state("failed", Some(&notice));
        task.append(evt("error", notice, None, None), 0);
        return;
    }
    let mut telemetry = json!({ "durationMs": task.started.elapsed().as_millis() as u64 });
    if let Some(model) = quota_model(response).or_else(|| fallback_model.map(str::to_owned)) {
        telemetry["modelId"] = json!(model);
    }
    if let Some(usage) = token_usage(&response["usage"]) {
        telemetry["tokenUsage"] = usage.clone();
        task.mutate(true, move |record| add_tokens(record, &usage));
    }
    let after = task
        .store
        .get(&task.key)
        .ok()
        .flatten()
        .and_then(|r| Some(r["cost"].clone()).filter(|c| !c.is_null()));
    if let Some(after) = after
        .as_ref()
        .filter(|c| c["amount"].as_f64().unwrap_or(0.0) > 0.0)
    {
        let base = task
            .cost_before
            .as_ref()
            .filter(|b| b["currency"] == after["currency"])
            .and_then(|b| b["amount"].as_f64())
            .unwrap_or(0.0);
        let turn = after["amount"].as_f64().unwrap_or(0.0) - base;
        if turn > 0.0 {
            telemetry["cost"] = json!({ "currency": after["currency"], "amount": turn });
        }
    }
    if !buffer.is_empty() {
        let mut message = evt("message", "Assistant", Some(buffer), None);
        if !reasoning.is_empty() {
            message["reasoning"] = json!(reasoning);
        }
        if let (Some(extra), Some(object)) = (telemetry.as_object(), message.as_object_mut()) {
            object.extend(extra.clone());
        }
        task.append(message, 0);
    }
    match stop.as_str() {
        "end_turn" | "max_turn_requests" => {
            task.set_state("completed", None);
            task.append(
                evt(
                    "task_complete",
                    if follow_up {
                        "Agent completed the follow-up"
                    } else {
                        "Agent completed the task"
                    },
                    None,
                    None,
                ),
                0,
            );
        }
        // abort already set the terminal state.
        "cancelled" => {}
        other => {
            let reason = format!("Agent stopped: {other}");
            task.set_state("failed", Some(&reason));
            task.append(evt("error", reason, None, None), 0);
        }
    }
}

fn token_usage(usage: &Value) -> Option<Value> {
    let input = usage["inputTokens"].as_u64();
    let output = usage["outputTokens"].as_u64();
    if input.is_none() && output.is_none() {
        return None;
    }
    let total = usage["totalTokens"]
        .as_u64()
        .unwrap_or(input.unwrap_or(0) + output.unwrap_or(0));
    let mut value = json!({ "inputTokens": input.unwrap_or(0), "outputTokens": output.unwrap_or(0), "totalTokens": total });
    if let Some(thought) = usage["thoughtTokens"].as_u64() {
        value["reasoningTokens"] = json!(thought);
    }
    if let Some(cached) = usage["cachedReadTokens"].as_u64() {
        value["cachedInputTokens"] = json!(cached);
    }
    Some(value)
}

fn add_tokens(record: &mut Value, usage: &Value) {
    let total = &mut record["tokenUsage"];
    if !total.is_object() {
        *total = json!({ "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 });
    }
    for field in [
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "reasoningTokens",
        "cachedInputTokens",
    ] {
        if let Some(add) = usage[field].as_u64() {
            total[field] = json!(total[field].as_u64().unwrap_or(0) + add);
        }
    }
}

/// The model that did the most work, from `_meta.quota.model_usage`.
fn quota_model(response: &Value) -> Option<String> {
    response["_meta"]["quota"]["model_usage"]
        .as_array()?
        .iter()
        .filter_map(|row| {
            Some((
                row["model"].as_str()?.trim().to_owned(),
                row["token_count"]["totalTokens"].as_u64().unwrap_or(0),
            ))
        })
        .filter(|(model, _)| !model.is_empty())
        .max_by_key(|(_, total)| *total)
        .map(|(model, _)| model)
}

// ── stopping ─────────────────────────────────────────────────────────────

async fn stop(task: &Arc<Task>, terminal: &str, event: Value) {
    if task.ending.swap(true, Ordering::SeqCst) {
        // A second stop while the first is draining must not block on a turn that may never settle.
        let _ = tokio::time::timeout(STOP_GRACE, task.done.notified()).await;
        return;
    }
    for waiting in task
        .pending
        .lock()
        .map(|mut p| p.drain(..).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        let _ = waiting.reply.send(Decision::Deny);
    }
    task.cancel.notify_waiters();
    // Ask politely, then stop waiting: cleanup kills the child regardless.
    let connection = task.connection.lock().ok().and_then(|c| c.clone());
    let session = task.agent_session_id.lock().ok().and_then(|s| s.clone());
    if let (Some(connection), Some(session)) = (connection, session) {
        let _ = tokio::time::timeout(
            CANCEL_GRACE,
            connection.notify("session/cancel", json!({ "sessionId": session })),
        )
        .await;
    }
    if !task.finished.load(Ordering::SeqCst) {
        let _ = tokio::time::timeout(STOP_GRACE, task.done.notified()).await;
    }
    if task.state().is_some_and(|state| !is_terminal(&state)) {
        task.set_state(terminal, None);
        task.append(event, 0);
    }
}

/// Aborts a running turn, then settles the session as aborted. Safe to call with nothing running.
pub fn abort_task(host: &HostContext, dir: &Path, key: &str) {
    let _ = host;
    abort_background(dir, key);
    if let Some(task) = find_task(dir, key) {
        let waiter = Arc::clone(&task);
        let (done, wait) = std::sync::mpsc::channel();
        runtime().spawn(async move {
            stop(
                &waiter,
                "aborted",
                evt("aborted", "Task aborted by user", None, None),
            )
            .await;
            finish(&waiter).await;
            let _ = done.send(());
        });
        let _ = wait.recv_timeout(CANCEL_GRACE + STOP_GRACE + Duration::from_secs(3));
    }
}

/// Stops observing provider background work for a session the person aborted.
fn abort_background(dir: &Path, key: &str) {
    let observers: Vec<Arc<Task>> = background_clients()
        .lock()
        .map(|all| {
            all.iter()
                .filter(|t| t.dir == dir && t.key == key)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    for task in observers {
        task.ending.store(true, Ordering::SeqCst);
        task.background_connection_lost("Background monitoring was cancelled. The provider task outcome has not been confirmed.");
        forget_background_client(&task);
        let (done, wait) = std::sync::mpsc::channel();
        runtime().spawn(async move {
            release_connection(&task).await;
            let _ = done.send(());
        });
        let _ = wait.recv_timeout(STOP_GRACE + Duration::from_secs(3));
    }
}

/// Answers the oldest pending permission request.
pub fn respond_to_permission(dir: &Path, key: &str, decision: Decision) {
    if let Some(task) = find_task(dir, key) {
        task.respond_to_permission(decision);
    }
}

/// Switches the agent's own Session Mode (`session/set_mode`) on a running session.
pub fn set_acp_mode(dir: &Path, key: &str, mode_id: &str) -> Result<()> {
    let task = find_task(dir, key)
        .filter(|task| !task.ending.load(Ordering::SeqCst))
        .ok_or_else(|| failure(format!("No active agent session for {key}.")))?;
    let connection = task
        .connection
        .lock()
        .ok()
        .and_then(|c| c.clone())
        .ok_or_else(|| failure("The agent is not connected yet."))?;
    let session = task
        .agent_session_id
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .ok_or_else(|| failure("The agent has not created a session yet."))?;
    let mode = mode_id.to_owned();
    super::runtime::block_on(async move {
        connection
            .request(
                "session/set_mode",
                json!({ "sessionId": session, "modeId": mode }),
            )
            .await
    })
    .map_err(|e| failure(e.to_string()))?;
    let mode = mode_id.to_owned();
    task.mutate(true, move |record| record["acpCurrentModeId"] = json!(mode));
    Ok(())
}

// ── follow-up turns ──────────────────────────────────────────────────────

/// What a follow-up needs beyond the session record.
pub struct Continue {
    pub message: String,
    pub images: Vec<Value>,
    pub provider: String,
    pub command: String,
    pub args: Vec<String>,
    pub mcp_servers: Vec<Value>,
    pub gadget_answer: bool,
    /// A turn Praxis schedules between the AIs of a multi-AI conversation, not typed by the user.
    pub internal: bool,
    pub conversation_context: Option<String>,
}

/// `Previous conversation:` plus the recent assistant/user text, for a session that cannot be resumed.
fn conversation_transcript(events: &[Value]) -> Option<String> {
    let turns: Vec<String> = events
        .iter()
        .filter_map(|event| {
            let detail = event["detail"]
                .as_str()
                .map(str::trim)
                .filter(|d| !d.is_empty())?;
            match event["type"].as_str()? {
                "message" => Some(format!("Assistant:\n{detail}")),
                "user_input_completed" => Some(format!("User:\n{detail}")),
                _ => None,
            }
        })
        .collect();
    if turns.is_empty() {
        return None;
    }
    let transcript = turns.join("\n\n");
    let budget = 128_000;
    let count = transcript.chars().count();
    Some(format!(
        "Previous conversation:\n\n{}",
        if count > budget {
            format!(
                "[Earlier conversation omitted to fit the prompt; the following is the most recent text.]\n{}",
                transcript.chars().skip(count - budget).collect::<String>()
            )
        } else {
            transcript
        }
    ))
}

/// Sends a follow-up on an existing session: resumes the agent's own session when it can, else
/// replays a bounded transcript.
pub fn continue_task(host: &HostContext, dir: &Path, key: &str, request: Continue) -> Result<()> {
    // Completion is published before the subprocess closes; give the old turn a moment to finish
    // closing instead of refusing an otherwise completed conversation.
    if let Some(old) = find_task(dir, key) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while find_task(dir, key).is_some()
            && old.state().as_deref() == Some("completed")
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    if has_active_task(dir, key) {
        return Err(failure(format!("The agent is still working on {key}.")));
    }
    let sessions = store(dir);
    let record = sessions
        .get(key)?
        .ok_or_else(|| failure(format!("No agent session found for {key}.")))?;
    let follow_up = request.message.trim().to_owned();
    if follow_up.is_empty() {
        return Err(failure("Enter a follow-up message."));
    }
    let tool_mode = record["toolMode"].as_str().unwrap_or("full").to_owned();
    let working = record["workingDirectory"]
        .as_str()
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .map(str::to_owned);
    let issue = json!({ "key": key, "summary": record["taskDefinition"]["goal"], "issueType": "Task", "status": "In progress", "description": record["taskDefinition"]["scope"] });
    let mut system = format!(
        "{}\n\nTool mode: {}",
        praxis_ai::session::prompt::build_system_prompt(&record["taskDefinition"], &issue),
        praxis_ai::session::prompt::tool_mode_prompt(&tool_mode)
    );
    if request
        .mcp_servers
        .iter()
        .any(|s| s["name"] == "praxis-browser")
    {
        system.push_str(&format!(
            "\n\n{}",
            praxis_ai::session::prompt::prompt("BROWSER_TOOLS_PROMPT")
        ));
    }
    if request
        .mcp_servers
        .iter()
        .any(|s| s["name"] == praxis_ai::session::prompt::code_intelligence_server_name())
    {
        system.push_str(&format!(
            "\n\n{}",
            praxis_ai::session::prompt::prompt("CODE_INTELLIGENCE_PROMPT")
        ));
    }
    if record["permissionMode"] == "autopilot" {
        system.push_str(&format!(
            "\n\n{}",
            praxis_ai::session::prompt::prompt("AUTOPILOT_SESSION_PROMPT")
        ));
    }
    if let Some(context) = request
        .conversation_context
        .as_deref()
        .filter(|c| !c.is_empty())
    {
        system.push_str(&format!("\n\n{context}"));
    }
    let current_turn = format!(
        "{}:\n{follow_up}",
        if request.internal {
            "Conversation routing instruction"
        } else {
            "User follow-up"
        }
    );
    let resumed_prompt = [system.clone(), current_turn.clone()].join("\n\n");
    let events = record["events"].as_array().cloned().unwrap_or_default();
    let prompt = [
        Some(system),
        conversation_transcript(&events),
        Some(current_turn),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");

    let session_id = record["sessionId"].as_str().unwrap_or_default().to_owned();
    let permission_mode = record["permissionMode"].as_str().map(str::to_owned);
    let working_directory = working
        .clone()
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    let model = record["model"].as_str().map(str::to_owned);
    let task = Arc::new(Task {
        key: key.to_owned(),
        dir: dir.to_path_buf(),
        host: host.clone(),
        store: Arc::clone(&sessions),
        connection: Mutex::new(None),
        agent_session_id: Mutex::new(None),
        ending: AtomicBool::new(false),
        prompt_in_flight: AtomicBool::new(false),
        allow_all: AtomicBool::new(record["autoApprovePermissions"] == true),
        auto_allow_safe: permission_mode.as_deref() == Some("auto"),
        pending: Mutex::default(),
        message: Mutex::default(),
        reasoning: Mutex::default(),
        steps: AtomicU32::new(0),
        started: Instant::now(),
        cost_before: Some(record["cost"].clone()).filter(|c| !c.is_null()),
        active_tool: Mutex::default(),
        tool_inputs: Mutex::default(),
        done: tokio::sync::Notify::new(),
        finished: AtomicBool::new(false),
        tool_mode: tool_mode.clone(),
        working_directory,
        owner_session_id: session_id,
        last_replay_ms: std::sync::atomic::AtomicU64::new(0),
        cancel: tokio::sync::Notify::new(),
        background: Default::default(),
    });
    if let Ok(mut all) = tasks().lock() {
        all.insert((dir.to_path_buf(), key.to_owned()), Arc::clone(&task));
    }
    // The previous turn recorded its own reply when it ended; clear the live buffer so the old answer
    // cannot briefly render after the new user message.
    task.mutate(true, |record| record["responseText"] = json!(""));
    let mut event = if request.internal {
        evt("conversation_turn", "Conversation turn started", None, None)
    } else {
        evt("user_input_completed", "You", Some(follow_up), None)
    };
    if !request.images.is_empty() {
        event["attachments"] = json!(request.images);
    }
    if request.gadget_answer {
        event["gadgetAnswer"] = json!(true);
    }
    task.append(event, 0);
    task.set_state("executing", None);

    let start = StartTask {
        issue,
        task: record["taskDefinition"].clone(),
        provider: request.provider,
        model,
        reasoning_effort: record["reasoningEffort"].as_str().map(str::to_owned),
        working_directory: working,
        tool_mode,
        permission_mode,
        auto_approve: record["autoApprovePermissions"] == true,
        command: request.command,
        args: request.args,
        mcp_servers: request.mcp_servers,
        images: Vec::new(),
    };
    let launch = Launch::FollowUp {
        prompt,
        resumed_prompt,
        resume_id: record["runtimeSessionId"].as_str().map(str::to_owned),
        images: request.images,
    };
    let runner = Arc::clone(&task);
    runtime().spawn(async move {
        run_turn(Arc::clone(&runner), start, launch).await;
        finish(&runner).await;
    });
    Ok(())
}

// ── shared with the API-provider host ───────────────────────────────────

#[allow(clippy::too_many_arguments)]
/// Builds and registers the shared task state for a turn with no ACP connection.
pub(super) fn register_api_task(
    host: &HostContext,
    dir: &Path,
    key: &str,
    session_id: &str,
    tool_mode: &str,
    working_directory: PathBuf,
    allow_all: bool,
    auto_allow_safe: bool,
    cost_before: Option<Value>,
) -> Arc<Task> {
    let task = Arc::new(Task {
        key: key.to_owned(),
        dir: dir.to_path_buf(),
        host: host.clone(),
        store: store(dir),
        connection: Mutex::new(None),
        agent_session_id: Mutex::new(None),
        ending: AtomicBool::new(false),
        prompt_in_flight: AtomicBool::new(false),
        allow_all: AtomicBool::new(allow_all),
        auto_allow_safe,
        pending: Mutex::default(),
        message: Mutex::default(),
        reasoning: Mutex::default(),
        steps: AtomicU32::new(0),
        started: Instant::now(),
        cost_before,
        active_tool: Mutex::default(),
        tool_inputs: Mutex::default(),
        done: tokio::sync::Notify::new(),
        finished: AtomicBool::new(false),
        tool_mode: tool_mode.to_owned(),
        working_directory,
        owner_session_id: session_id.to_owned(),
        last_replay_ms: std::sync::atomic::AtomicU64::new(0),
        cancel: tokio::sync::Notify::new(),
        background: Default::default(),
    });
    if let Ok(mut all) = tasks().lock() {
        all.insert((dir.to_path_buf(), key.to_owned()), Arc::clone(&task));
    }
    task
}

pub(super) async fn finish_task(task: &Arc<Task>) {
    finish(task).await;
}

pub(super) async fn stop_task(task: &Arc<Task>, terminal: &str, event: Value) {
    stop(task, terminal, event).await;
}

pub(super) fn fail(task: &Task, message: String) {
    fail_turn(task, message);
}

pub(super) fn find_active(dir: &Path, key: &str) -> Option<Arc<Task>> {
    find_task(dir, key)
}
