//! Hosts a session on an API provider (Vercel gateway, OpenAI, Anthropic, Gemini, Z.ai or a
//! custom OpenAI-compatible endpoint). Ports `VercelAgentService` + `agentLoop.ts`: a streaming
//! chat-completions loop with local file/shell tools, mapped onto the same session record and
//! events the ACP host writes.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use praxis_ai::providers::model_catalog::{GatewayOptions, KeyAuth, endpoint, list_catalog_models};
use praxis_ai::providers::model_pricing::{estimate_turn_cost, get_known_context_length};
use praxis_ai::providers::provider_limit_error::{extract_provider_limit_message, is_limit_notice_reply, is_provider_limit_error};
use praxis_ai::providers::anthropic_wire::{AnthropicRequestOptions, anthropic_request_body, anthropic_stream_event};
use praxis_ai::providers::gemini_wire::{GeminiRequestOptions, gemini_request_body, gemini_stream_event};
use praxis_ai::providers::reasoning_support::{ReasoningEffort, ReasoningFamily, anthropic_thinking_config, detect_reasoning_family, gemini_thinking_budget};
use praxis_ai::providers::wire::{
    ChatCompletionResult, ChatCompletionToolCall, ChatRequestOptions, ChatStreamEvent, EventStream, GatewayToolDefinition, OpenAiToolCall, SseEvent, TokenUsage, ToolResult, WireMessage,
    WireRole, assistant_message_with_tool_calls, build_chat_request, consume_chat_stream, parse_tool_arguments, tool_result_messages, trim_tool_output_to_budget,
};
use praxis_ai::mcp::builtin::read_only_files::resolve_sandboxed_path;
use praxis_core::unified_diff::create_unified_diff;
use praxis_host::HostContext;
use serde_json::{Value, json};

use super::acp_host::{Task, evt, fail, finish_task, register_api_task, stop_task};
use super::runtime::runtime;
use super::session_store::store;
use super::{Result, failure, now};

const DEFAULT_HISTORY_BUDGET_CHARS: usize = 480_000;
const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const SHELL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_LIST_ENTRIES: usize = 500;
const MAX_DIFF_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Wire {
    OpenAi,
    Anthropic,
    Gemini,
}

/// Everything about reaching one API provider.
#[derive(Clone)]
pub struct ApiConnection {
    pub wire: Wire,
    pub options: GatewayOptions,
    pub stream_usage: bool,
    pub provider: String,
    pub label: String,
}

pub struct ApiStart {
    pub issue: Value,
    pub task: Value,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub working_directory: Option<String>,
    pub tool_mode: String,
    pub permission_mode: Option<String>,
    pub auto_approve: bool,
    pub images: Vec<Value>,
    pub connection: ApiConnection,
}

// ── HTTP + SSE ───────────────────────────────────────────────────────────

struct HttpSse {
    response: reqwest::Response,
    buffer: String,
    event: Option<String>,
    data: Vec<String>,
    queue: VecDeque<SseEvent>,
}

#[async_trait::async_trait]
impl EventStream for HttpSse {
    async fn next_event(&mut self) -> Option<std::result::Result<SseEvent, String>> {
        loop {
            if let Some(event) = self.queue.pop_front() {
                return Some(Ok(event));
            }
            let chunk = match tokio::time::timeout(IDLE_TIMEOUT, self.response.chunk()).await {
                Err(_) => return Some(Err(format!("The provider sent nothing for {}s.", IDLE_TIMEOUT.as_secs()))),
                Ok(Err(error)) => return Some(Err(error.to_string())),
                Ok(Ok(None)) => {
                    if self.data.is_empty() {
                        return None;
                    }
                    let event = SseEvent { event: self.event.take(), data: self.data.drain(..).collect::<Vec<_>>().join("\n") };
                    return Some(Ok(event));
                }
                Ok(Ok(Some(chunk))) => chunk,
            };
            self.buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(newline) = self.buffer.find('\n') {
                let line: String = self.buffer.drain(..=newline).collect();
                let line = line.trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    if !self.data.is_empty() {
                        self.queue.push_back(SseEvent { event: self.event.take(), data: self.data.drain(..).collect::<Vec<_>>().join("\n") });
                    }
                    self.event = None;
                } else if let Some(rest) = line.strip_prefix("event:") {
                    self.event = Some(rest.trim().to_owned());
                } else if let Some(rest) = line.strip_prefix("data:") {
                    self.data.push(rest.strip_prefix(' ').unwrap_or(rest).to_owned());
                }
            }
        }
    }
}

fn non_retryable(body: &str) -> bool {
    let lowered = body.to_lowercase();
    ["\"1113\"", "\"1001\"", "insufficient", "no resource package", "please recharge", "credit balance"].iter().any(|needle| lowered.contains(needle))
}

fn request_for(connection: &ApiConnection, model: &str) -> (String, Vec<(String, String)>) {
    let options = &connection.options;
    let mut headers: Vec<(String, String)> = options.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    headers.push(("Accept".into(), "text/event-stream".into()));
    let key = options.api_key.as_deref().filter(|k| !k.is_empty());
    match connection.wire {
        Wire::OpenAi => {
            if let Some(key) = key {
                match &options.auth {
                    KeyAuth::Bearer => headers.push(("Authorization".into(), format!("Bearer {key}"))),
                    KeyAuth::Header(name) => headers.push((name.clone(), key.to_owned())),
                    KeyAuth::None => {}
                }
            }
            (endpoint(options, "/chat/completions"), headers)
        }
        Wire::Anthropic => {
            headers.push(("anthropic-version".into(), "2023-06-01".into()));
            if let Some(key) = key {
                headers.push(("x-api-key".into(), key.to_owned()));
            }
            (format!("{}/v1/messages", options.url.trim_end_matches('/')), headers)
        }
        Wire::Gemini => {
            if let Some(key) = key {
                headers.push(("x-goog-api-key".into(), key.to_owned()));
            }
            let base = Some(options.url.trim()).filter(|u| !u.is_empty()).unwrap_or(praxis_ai::providers::registry::DEFAULT_GEMINI_BASE_URL).trim_end_matches('/');
            (format!("{base}/v1beta/models/{model}:streamGenerateContent?alt=sse"), headers)
        }
    }
}

async fn post_stream(connection: &ApiConnection, model: &str, body: &Value) -> std::result::Result<HttpSse, String> {
    let (url, headers) = request_for(connection, model);
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let mut attempt = 0;
    loop {
        let mut request = client.post(&url).json(body);
        for (name, value) in &headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        if status.is_success() {
            return Ok(HttpSse { response, buffer: String::new(), event: None, data: Vec::new(), queue: VecDeque::new() });
        }
        let text = response.text().await.unwrap_or_default();
        let retryable = matches!(status.as_u16(), 429 | 502 | 503 | 504) && !non_retryable(&text);
        attempt += 1;
        if !retryable || attempt >= 3 {
            return Err(format!("HTTP {}: {}", status.as_u16(), text));
        }
        tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
    }
}

/// One completion from a stream, whichever wire it arrived on.
async fn collect(connection: &ApiConnection, mut sse: HttpSse, mut on_text: impl FnMut(&str)) -> std::result::Result<ChatCompletionResult, String> {
    if connection.wire == Wire::OpenAi {
        let mut seen = 0usize;
        let _ = &mut seen;
        return consume_chat_stream(&mut sse, |event| {
            if let ChatStreamEvent::Text { text } = event {
                on_text(&text);
            }
        })
        .await;
    }
    let mut text = String::new();
    let mut drafts: Vec<(Option<String>, Option<String>, String)> = Vec::new();
    let mut usage = TokenUsage::default();
    let mut done: Option<ChatCompletionResult> = None;
    while let Some(event) = sse.next_event().await {
        let event = event?;
        let parsed = match connection.wire {
            Wire::Anthropic => {
                // Anthropic names each event twice (an `event:` line and the payload's `type`); some
                // proxies and test servers send only the payload.
                let named = event.event.clone().or_else(|| serde_json::from_str::<Value>(&event.data).ok().and_then(|p| p["type"].as_str().map(str::to_owned)));
                anthropic_stream_event(named.as_deref().unwrap_or_default(), &event.data)
            }
            _ => gemini_stream_event(&event.data),
        };
        match parsed {
            Some(ChatStreamEvent::Text { text: piece }) => {
                on_text(&piece);
                text.push_str(&piece);
            }
            Some(ChatStreamEvent::ToolCall { index, id, name, args_delta }) => {
                while drafts.len() <= index {
                    drafts.push((None, None, String::new()));
                }
                if id.is_some() {
                    drafts[index].0 = id;
                }
                if name.is_some() {
                    drafts[index].1 = name;
                }
                if let Some(delta) = args_delta {
                    drafts[index].2.push_str(&delta);
                }
            }
            Some(ChatStreamEvent::Usage { usage: reported }) => {
                usage = TokenUsage {
                    input_tokens: reported.input_tokens.or(usage.input_tokens),
                    output_tokens: reported.output_tokens.or(usage.output_tokens),
                    total_tokens: reported.total_tokens.or(usage.total_tokens),
                    reasoning_tokens: reported.reasoning_tokens.or(usage.reasoning_tokens),
                    cached_input_tokens: reported.cached_input_tokens.or(usage.cached_input_tokens),
                };
            }
            Some(ChatStreamEvent::Done { result }) => done = Some(result),
            None => {}
        }
    }
    if let Some(result) = done {
        return Ok(result);
    }
    let tool_calls = drafts
        .into_iter()
        .enumerate()
        .filter_map(|(index, (id, name, args))| Some(ChatCompletionToolCall { id: id.unwrap_or_else(|| format!("call_{index}")), name: name?, arguments: parse_tool_arguments(&args) }))
        .collect();
    Ok(ChatCompletionResult { text, thought: String::new(), tool_calls, finish_reason: None, usage: usage.with_derived_total() })
}

// ── local tools ──────────────────────────────────────────────────────────

fn tool_definitions(tool_mode: &str) -> Vec<GatewayToolDefinition> {
    let tool = |name: &str, description: &str, schema: Value| GatewayToolDefinition { name: name.into(), description: Some(description.into()), input_schema: Some(schema) };
    let path = json!({ "type": "string", "description": "File path relative to the working directory" });
    let read = vec![
        tool("read_file", "Read a UTF-8 text file relative to the working directory.", json!({ "type": "object", "properties": { "path": path }, "required": ["path"] })),
        tool("list_dir", "List files and directories under a path relative to the working directory.", json!({ "type": "object", "properties": { "path": { "type": "string", "description": "Directory path relative to the working directory (default \".\")" } } })),
    ];
    match tool_mode {
        "project-only" => Vec::new(),
        "read-only" => read,
        _ => {
            let mut all = read;
            all.push(tool("write_file", "Write a UTF-8 text file relative to the working directory (creates parents).", json!({ "type": "object", "properties": { "path": path, "content": { "type": "string", "description": "Full file contents to write" } }, "required": ["path", "content"] })));
            all.push(tool("run_shell", "Run a shell command in the working directory and return stdout/stderr.", json!({ "type": "object", "properties": { "command": { "type": "string", "description": "Shell command to execute" } }, "required": ["command"] })));
            all
        }
    }
}

fn parse_effort(effort: Option<&str>) -> Option<ReasoningEffort> {
    match effort? {
        "low" => Some(ReasoningEffort::Low),
        "medium" => Some(ReasoningEffort::Medium),
        "high" => Some(ReasoningEffort::High),
        _ => None, // `off` and anything unknown request no reasoning
    }
}

/// The reasoning request for the shared OpenAI-compatible wire. A model id routed through it can
/// still be a Claude or Gemini model underneath (e.g. the gateway's `anthropic/claude-…`), which
/// needs that provider's own shape through the `providerOptions` passthrough; everything else uses
/// the standard `reasoning_effort` field. Nothing is sent unless a non-`off` level is selected.
fn apply_openai_reasoning(body: &mut Value, model: &str, effort: Option<&str>) {
    let Some(level) = parse_effort(effort) else { return };
    match detect_reasoning_family(Some(model)) {
        Some(ReasoningFamily::Anthropic) => {
            if let Some(config) = anthropic_thinking_config(Some(model), Some(level))
                && let Some(thinking) = config.thinking
            {
                let mut options = json!({ "thinking": thinking });
                if let Some(output) = config.output_config {
                    options["output_config"] = output;
                }
                if let Some(budget) = options["thinking"]["budget_tokens"].as_u64() {
                    let current = body["max_tokens"].as_u64().unwrap_or(0);
                    body["max_tokens"] = json!(current.max(budget + 1024));
                }
                // Anthropic rejects a custom temperature alongside thinking.
                body.as_object_mut().map(|o| o.remove("temperature"));
                body["providerOptions"]["anthropic"] = options;
            }
        }
        Some(ReasoningFamily::Gemini) => {
            if let Some(budget) = gemini_thinking_budget(Some(level)) {
                body["providerOptions"]["google"] = json!({ "thinkingConfig": { "thinkingBudget": budget, "includeThoughts": true } });
            }
        }
        _ => body["reasoning_effort"] = json!(level.as_str()),
    }
}

fn classify_tool(name: &str) -> &'static str {
    match name {
        "write_file" => "write",
        "run_shell" => "shell",
        "read_file" | "read_image" => "read",
        "list_dir" => "search",
        _ => "other",
    }
}

struct ToolOutcome {
    ok: bool,
    content: String,
    data: Option<Value>,
}

fn failed(content: impl Into<String>) -> ToolOutcome {
    ToolOutcome { ok: false, content: content.into(), data: None }
}

async fn run_tool(task: &Arc<Task>, call: &ChatCompletionToolCall) -> ToolOutcome {
    let args = &call.arguments;
    let text = |key: &str| args[key].as_str().unwrap_or_default().to_owned();
    if task.tool_mode == "project-only" {
        return failed(format!("{} is unavailable without a project workspace folder.", call.name));
    }
    if task.tool_mode == "read-only" && !matches!(call.name.as_str(), "read_file" | "list_dir" | "read_image") {
        return failed(format!("{} is unavailable in read-only tool mode.", call.name));
    }
    let root = &task.working_directory;
    match call.name.as_str() {
        "read_file" => match resolve_sandboxed_path(root, &text("path")).and_then(|p| std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))) {
            Ok(content) => ToolOutcome { ok: true, content, data: None },
            Err(error) => failed(error),
        },
        "list_dir" => {
            let requested = Some(text("path")).filter(|p| !p.is_empty()).unwrap_or_else(|| ".".into());
            match resolve_sandboxed_path(root, &requested).and_then(|p| std::fs::read_dir(&p).map_err(|e| format!("{}: {e}", p.display()))) {
                Ok(entries) => {
                    let mut names: Vec<String> = entries.flatten().map(|e| format!("{}{}", e.file_name().to_string_lossy(), if e.file_type().is_ok_and(|t| t.is_dir()) { "/" } else { "" })).collect();
                    names.sort();
                    let more = names.len().saturating_sub(MAX_LIST_ENTRIES);
                    names.truncate(MAX_LIST_ENTRIES);
                    if more > 0 {
                        names.push(format!("… and {more} more"));
                    }
                    ToolOutcome { ok: true, content: names.join("\n"), data: None }
                }
                Err(error) => failed(error),
            }
        }
        "write_file" => {
            let path = text("path");
            let request = json!({ "toolCallId": call.id, "title": format!("Write {path}"), "name": "write_file", "kind": "edit", "rawInput": args });
            if task.request_permission(request).await == super::acp_host::Decision::Deny {
                return failed("Permission denied for write_file");
            }
            let content = text("content");
            match resolve_sandboxed_path(root, &path) {
                Err(error) => failed(error),
                Ok(full) => {
                    let before = std::fs::read_to_string(&full).ok();
                    if let Some(parent) = full.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Err(error) = std::fs::write(&full, &content) {
                        return failed(format!("{}: {error}", full.display()));
                    }
                    let diff = (before.as_deref().map_or(0, str::len) + content.len() <= MAX_DIFF_BYTES).then(|| create_unified_diff(&path, before.as_deref().unwrap_or_default(), &content, 3));
                    let mut data = json!({ "kind": "write", "fileChanges": [{ "path": path, "oldText": before.clone().unwrap_or_default(), "newText": content }] });
                    if let Some(diff) = diff {
                        data["diff"] = json!(diff);
                        data["fileChanges"][0]["diff"] = json!(diff);
                    }
                    ToolOutcome { ok: true, content: format!("Wrote {path}"), data: Some(data) }
                }
            }
        }
        "run_shell" => {
            let command = text("command");
            if command.trim().is_empty() {
                return failed("command is required");
            }
            let request = json!({ "toolCallId": call.id, "title": "Permission requested: run_shell", "name": "run_shell", "kind": "execute", "rawInput": { "command": command } });
            if task.request_permission(request).await == super::acp_host::Decision::Deny {
                return failed("Permission denied for run_shell");
            }
            let child = tokio::process::Command::new("/bin/sh").arg("-c").arg(&command).current_dir(root).env("PATH", praxis_ai::providers::environment::effective_path()).stdin(std::process::Stdio::null()).kill_on_drop(true).output();
            match tokio::time::timeout(SHELL_TIMEOUT, child).await {
                Err(_) => failed(format!("exit error: command timed out after {}s", SHELL_TIMEOUT.as_secs())),
                Ok(Err(error)) => failed(error.to_string()),
                Ok(Ok(output)) => {
                    let combined = [String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&output.stderr).into_owned()].into_iter().filter(|p| !p.trim().is_empty()).collect::<Vec<_>>().join("\n").trim().to_owned();
                    let parts = [combined, if output.status.success() { String::new() } else { format!("exit error: exited with {}", output.status.code().map_or("a signal".into(), |c| c.to_string())) }];
                    ToolOutcome { ok: output.status.success(), content: parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n"), data: None }
                }
            }
        }
        other => failed(format!("Unknown tool: {other}")),
    }
}

// ── the loop ─────────────────────────────────────────────────────────────

struct Turn {
    usage: Option<TokenUsage>,
    estimate: Option<TokenUsage>,
    tools: Vec<String>,
    started: Instant,
    reasoning_emitted: usize,
    prompt_chars: usize,
}

fn sum(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    if a.is_none() && b.is_none() { None } else { Some(a.unwrap_or(0) + b.unwrap_or(0)) }
}

pub(super) fn usage_json(usage: &TokenUsage) -> Value {
    let mut value = json!({});
    for (key, field) in [("inputTokens", usage.input_tokens), ("outputTokens", usage.output_tokens), ("totalTokens", usage.total_tokens), ("reasoningTokens", usage.reasoning_tokens), ("cachedInputTokens", usage.cached_input_tokens)] {
        if let Some(n) = field {
            value[key] = json!(n);
        }
    }
    value
}

/// `addAgentTokenUsage`: session and epoch totals, context occupancy from the turn's prompt, and a
/// cost estimate where a price table covers the model.
fn add_usage(task: &Task, usage: TokenUsage, provider: &str, model: &str) {
    let (provider, model) = (provider.to_owned(), model.to_owned());
    task.mutate(true, move |record| {
        let add = |slot: &mut Value, usage: &TokenUsage| {
            if !slot.is_object() {
                *slot = json!({});
            }
            for (key, field) in [("inputTokens", usage.input_tokens), ("outputTokens", usage.output_tokens), ("totalTokens", usage.total_tokens)] {
                if let Some(n) = field {
                    slot[key] = json!(slot[key].as_u64().unwrap_or(0) + n);
                }
            }
        };
        add(&mut record["tokenUsage"], &usage);
        if let Some(epoch) = record["runtimeEpochs"].as_array_mut().and_then(|epochs| epochs.iter_mut().find(|e| e["endedAt"].is_null())) {
            add(&mut epoch["tokenUsage"], &usage);
        }
        // Context pressure is this turn's prompt, not the running total.
        if let Some(input) = usage.input_tokens {
            record["contextTokens"] = json!(input);
        }
        if let Some(cost) = estimate_turn_cost(Some(&provider), Some(&model), usage) {
            let prior = record["cost"]["amount"].as_f64().filter(|_| record["cost"]["currency"] == cost.currency).unwrap_or(0.0);
            record["cost"] = json!({ "amount": prior + cost.amount, "currency": cost.currency });
        }
    });
}

fn note_context_limit(task: &Arc<Task>, connection: &ApiConnection, model: &str) {
    if let Some(known) = get_known_context_length(Some(model), Some(&connection.provider)) {
        task.mutate(true, move |record| record["contextLimit"] = json!(known));
    }
    let (task, connection, model) = (Arc::clone(task), connection.clone(), model.to_owned());
    runtime().spawn(async move {
        if let Ok(choices) = list_catalog_models(&connection.provider, &connection.options, &[], false).await
            && let Some(limit) = choices.iter().find(|c| c["value"] == model).and_then(|c| c["contextLength"].as_u64())
        {
            task.mutate(true, move |record| record["contextLimit"] = json!(limit));
        }
    });
}

enum Outcome {
    Completed,
    Aborted,
    Failed(String),
    StepLimit(String),
}

async fn run_loop(task: &Arc<Task>, connection: &ApiConnection, model: &str, system: String, mut history: Vec<WireMessage>, tool_mode: &str, max_steps: u64, reasoning: Option<&str>) -> (Outcome, Vec<WireMessage>) {
    let tools = tool_definitions(tool_mode);
    // The gateway's internal model ids carry a `Vercel/` prefix that is not part of the wire id.
    let wire_model = model.strip_prefix("Vercel/").unwrap_or(model).to_owned();
    let mut steps = 0u64;
    let mut read_counts: HashMap<String, u32> = HashMap::new();
    let mut duplicate_reads = 0u32;
    let mut nudged = false;
    let read_only = tools.iter().all(|t| matches!(t.name.as_str(), "read_file" | "list_dir" | "read_image"));
    let provider_label = connection.label.clone();
    let _ = provider_label;
    loop {
        if task.ending.load(Ordering::SeqCst) {
            return (Outcome::Aborted, history);
        }
        let mut messages = vec![WireMessage::text(WireRole::System, system.clone())];
        messages.extend(history.iter().cloned());
        let force_final = duplicate_reads >= 4 || (read_only && steps >= 30);
        let active_tools = if force_final { Vec::new() } else { tools.clone() };
        let body = match connection.wire {
            Wire::OpenAi => {
                let mut request = build_chat_request(&messages, &wire_model, &ChatRequestOptions { tools: active_tools, stream: true, ..ChatRequestOptions::default() }).body;
                if !connection.stream_usage {
                    request.as_object_mut().map(|o| o.remove("stream_options"));
                }
                apply_openai_reasoning(&mut request, &wire_model, reasoning);
                request
            }
            Wire::Anthropic => {
                let mut request = anthropic_request_body(&messages, &wire_model, &AnthropicRequestOptions { tools: active_tools, reasoning_effort: parse_effort(reasoning), ..AnthropicRequestOptions::default() });
                request["stream"] = json!(true);
                request
            }
            Wire::Gemini => gemini_request_body(&messages, &GeminiRequestOptions { tools: active_tools, ..GeminiRequestOptions::default() }),
        };
        let prompt_chars: usize = messages.iter().map(|m| m.content.as_deref().map_or(0, |c| c.chars().count())).sum();
        let mut turn = Turn { usage: None, estimate: None, tools: Vec::new(), started: Instant::now(), reasoning_emitted: 0, prompt_chars };
        let _ = (&mut turn.estimate, &mut turn.reasoning_emitted, &turn.prompt_chars);

        let cancelled = task.cancel.notified();
        tokio::pin!(cancelled);
        let task_for_text = Arc::clone(task);
        let step = async {
            let sse = post_stream(connection, &wire_model, &body).await?;
            collect(connection, sse, |piece| {
                let buffer = {
                    let mut buffer = task_for_text.message.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    buffer.push_str(piece);
                    buffer.clone()
                };
                task_for_text.mutate(false, move |record| {
                    record["responseText"] = json!(buffer);
                    if record["state"] == "planning" {
                        record["planText"] = json!(buffer);
                    }
                });
            })
            .await
        };
        let completion = tokio::select! {
            () = &mut cancelled => return (Outcome::Aborted, history),
            result = step => match result {
                Ok(completion) => completion,
                Err(error) => return (Outcome::Failed(error), history),
            },
        };

        let reported = completion.usage;
        let has_usage = reported.input_tokens.is_some() || reported.output_tokens.is_some() || reported.total_tokens.is_some();
        if has_usage {
            turn.usage = Some(TokenUsage {
                input_tokens: sum(turn.usage.and_then(|u| u.input_tokens), reported.input_tokens),
                output_tokens: sum(turn.usage.and_then(|u| u.output_tokens), reported.output_tokens),
                total_tokens: sum(turn.usage.and_then(|u| u.total_tokens), reported.total_tokens),
                reasoning_tokens: sum(turn.usage.and_then(|u| u.reasoning_tokens), reported.reasoning_tokens),
                cached_input_tokens: sum(turn.usage.and_then(|u| u.cached_input_tokens), reported.cached_input_tokens),
            });
            add_usage(task, reported, &connection.provider, model);
        }

        let text = completion.text.clone();
        if !text.is_empty() {
            let buffer = text.clone();
            task.mutate(true, move |record| record["responseText"] = json!(buffer));
            if is_limit_notice_reply(&text) {
                let notice = extract_provider_limit_message(&text).unwrap_or_else(|| text.clone());
                task.set_state("failed", Some(&notice));
                task.append(evt("error", notice.clone(), None, None), 0);
                return (Outcome::Failed(notice), history);
            }
            emit_message(task, &mut turn, &text, &completion, connection, model, &system);
        }

        if completion.tool_calls.is_empty() {
            if text.trim().is_empty() {
                let message = completion.finish_reason.as_deref().map_or_else(|| "Model returned an empty response.".to_owned(), |reason| format!("Model returned an empty response (finish reason: {reason})."));
                task.append(evt("error", message.clone(), None, None), 0);
                return (Outcome::Failed(message), history);
            }
            history.push(WireMessage::text(WireRole::Assistant, text));
            task.append(evt("task_complete", "Agent completed the task", None, None), 0);
            return (Outcome::Completed, history);
        }

        let wire_calls: Vec<OpenAiToolCall> = completion.tool_calls.iter().map(|c| OpenAiToolCall::function(c.id.clone(), c.name.clone(), c.arguments.to_string())).collect();
        history.push(assistant_message_with_tool_calls(&text, &wire_calls));
        let mut results: Vec<ToolResult> = Vec::new();
        for call in &completion.tool_calls {
            if task.ending.load(Ordering::SeqCst) {
                return (Outcome::Aborted, history);
            }
            if steps >= max_steps {
                let message = format!("Agent reached maxSteps ({max_steps}).");
                task.append(evt("error", message.clone(), None, None), 0);
                return (Outcome::StepLimit(message), history);
            }
            steps += 1;
            if !turn.tools.contains(&call.name) {
                turn.tools.push(call.name.clone());
            }
            let args_summary = args_summary(&call.name, &call.arguments);
            task.append(evt("tool_start", format!("Running tool: {}", call.name), Some(serde_json::to_string_pretty(&call.arguments).unwrap_or_default()), Some(json!({ "toolName": call.name, "kind": classify_tool(&call.name), "args": call.arguments, "argsSummary": args_summary }))), 0);

            let is_read = matches!(call.name.as_str(), "read_file" | "list_dir" | "read_image");
            let key = format!("{}:{}", call.name, call.arguments);
            let prior = read_counts.get(&key).copied().unwrap_or(0);
            if is_read {
                read_counts.insert(key, prior + 1);
            } else {
                read_counts.clear();
                duplicate_reads = 0;
            }
            let outcome = if is_read && prior >= 2 {
                duplicate_reads += 1;
                let target = call.arguments["path"].as_str().unwrap_or("this target");
                ToolOutcome { ok: true, content: format!("[Notice: You have already inspected {target} {} times in this session. Its contents have not changed and will not be re-read. Do not re-inspect files in a loop. You have gathered sufficient codebase context; synthesize your findings and produce your required stage response now.]", prior + 1), data: None }
            } else {
                if is_read {
                    duplicate_reads = 0;
                }
                run_tool(task, call).await
            };
            let mut data = outcome.data.clone().unwrap_or_else(|| json!({}));
            data["toolName"] = json!(call.name);
            data["ok"] = json!(outcome.ok);
            if data["kind"].is_null() {
                data["kind"] = json!(classify_tool(&call.name));
            }
            task.append(evt("tool_complete", format!("Tool {}: {}", if outcome.ok { "completed" } else { "failed" }, call.name), Some(outcome.content.chars().take(2000).collect()), Some(data)), 1);
            results.push(ToolResult { call_id: Some(call.id.clone()), content: outcome.content });
        }
        history.extend(tool_result_messages(&wire_calls, &results));
        if !nudged && (duplicate_reads >= 2 || (read_only && steps >= 25)) {
            nudged = true;
            history.push(WireMessage::text(WireRole::User, "You have gathered comprehensive context from the codebase. Do not invoke any further tools. Deliver your complete output and final response now."));
        }
        // Bound the conversation before the provider does it with a context-length error.
        let trimmed = trim_history(&mut history, DEFAULT_HISTORY_BUDGET_CHARS);
        if trimmed > 0 {
            task.append(evt("message", format!("Dropped {trimmed} earlier tool result{} to stay within the context window", if trimmed == 1 { "" } else { "s" }), None, None), 0);
        }
    }
}

/// Elides the oldest tool outputs once the conversation passes `budget` characters. The tool
/// message itself stays (an assistant tool call without its result is a protocol error).
fn trim_history(history: &mut [WireMessage], budget: usize) -> usize {
    let total = |h: &[WireMessage]| -> usize { h.iter().map(|m| m.content.as_deref().map_or(0, |c| c.chars().count())).sum() };
    let mut dropped = 0;
    let mut size = total(history);
    for message in history.iter_mut() {
        if size <= budget {
            break;
        }
        if message.role == WireRole::Tool && let Some(content) = message.content.as_mut() && content.chars().count() > 200 {
            let before = content.chars().count();
            *content = trim_tool_output_to_budget("[Earlier tool output elided to stay within the context window]", 200);
            size = size.saturating_sub(before).saturating_add(content.chars().count());
            dropped += 1;
        }
    }
    dropped
}

fn args_summary(name: &str, args: &Value) -> String {
    let string = |key: &str| args[key].as_str().unwrap_or_default();
    match name {
        "read_file" | "write_file" | "list_dir" | "read_image" => string("path").to_owned(),
        "run_shell" => string("command").chars().take(120).collect(),
        _ => String::new(),
    }
}

fn emit_message(task: &Arc<Task>, turn: &mut Turn, text: &str, completion: &ChatCompletionResult, connection: &ApiConnection, model: &str, system: &str) {
    let preview = if text.chars().count() > 200 { format!("{}…", text.chars().take(200).collect::<String>()) } else { text.to_owned() };
    let reasoning_all = task.reasoning.lock().map(|r| r.clone()).unwrap_or_default();
    let thought = completion.thought.trim().to_owned();
    let reasoning = if !thought.is_empty() { thought } else { reasoning_all.chars().skip(turn.reasoning_emitted).collect::<String>().trim().to_owned() };
    turn.reasoning_emitted = reasoning_all.chars().count();
    let mut usage = turn.usage;
    if usage.is_none() {
        // The provider reported nothing (e.g. the Z.ai PaaS endpoint): estimate one round trip.
        let input = Some(((turn.prompt_chars.max(system.chars().count())) as f64 / 3.5).ceil() as u64).filter(|n| *n > 0);
        let output = Some((text.chars().count() as f64 / 3.5).ceil() as u64).filter(|n| *n > 0);
        let estimate = TokenUsage { input_tokens: input, output_tokens: output, total_tokens: sum(input, output), ..TokenUsage::default() };
        add_usage(task, estimate, &connection.provider, model);
        turn.estimate = Some(TokenUsage {
            input_tokens: sum(turn.estimate.and_then(|u| u.input_tokens), estimate.input_tokens),
            output_tokens: sum(turn.estimate.and_then(|u| u.output_tokens), estimate.output_tokens),
            total_tokens: sum(turn.estimate.and_then(|u| u.total_tokens), estimate.total_tokens),
            ..TokenUsage::default()
        });
        usage = turn.estimate;
    }
    let mut message = evt("message", preview, Some(text.to_owned()), None);
    if !reasoning.is_empty() {
        message["reasoning"] = json!(reasoning);
    }
    message["durationMs"] = json!(turn.started.elapsed().as_millis() as u64);
    message["modelId"] = json!(model);
    if let Some(usage) = usage {
        message["tokenUsage"] = usage_json(&usage);
        if let Some(cost) = estimate_turn_cost(Some(&connection.provider), Some(model), usage) {
            message["cost"] = json!({ "amount": cost.amount, "currency": cost.currency });
        }
    }
    if !turn.tools.is_empty() {
        message["toolNames"] = json!(turn.tools);
    }
    task.append(message, 0);
    if task.store.get(&task.key).ok().flatten().is_some_and(|r| r["state"] == "planning") {
        let plan = text.to_owned();
        task.mutate(true, move |record| record["planText"] = json!(plan));
        task.set_state("executing", None);
    }
}

// ── start / continue ─────────────────────────────────────────────────────

fn history_to_value(history: &[WireMessage]) -> Value {
    serde_json::to_value(history).unwrap_or(Value::Null)
}

fn history_from_record(record: &Value) -> Vec<WireMessage> {
    serde_json::from_value(record["conversationHistory"].clone()).unwrap_or_default()
}

async fn run_session(task: Arc<Task>, connection: ApiConnection, model: String, system: String, history: Vec<WireMessage>, tool_mode: String, max_steps: u64, timeout: Duration, reasoning: Option<String>) {
    let outcome = tokio::time::timeout(timeout, run_loop(&task, &connection, &model, system, history, &tool_mode, max_steps, reasoning.as_deref())).await;
    match outcome {
        Err(_) => stop_task(&task, "failed", evt("error", format!("Task stopped after timing out at {}s.", timeout.as_secs()), None, None)).await,
        Ok((result, history)) => {
            if !task.ending.load(Ordering::SeqCst) {
                let saved = history_to_value(&history);
                let text = task.message.lock().map(|m| m.clone()).unwrap_or_default();
                task.mutate(true, move |record| {
                    record["conversationHistory"] = saved;
                    if !text.is_empty() {
                        record["responseText"] = json!(text);
                    }
                });
                match result {
                    Outcome::Completed => {
                        task.set_state("completed", None);
                        task.append(evt("idle", "Agent session idle after completion", None, None), 0);
                    }
                    Outcome::Aborted => {}
                    Outcome::Failed(error) | Outcome::StepLimit(error) => {
                        let shown = [Some(error.clone()), task.message.lock().ok().map(|m| m.clone())].into_iter().flatten().find(|t| is_provider_limit_error(t)).map(|t| extract_provider_limit_message(&t).unwrap_or(t)).unwrap_or(error);
                        let already = task.store.get(&task.key).ok().flatten().is_some_and(|r| r["events"].as_array().is_some_and(|events| events.iter().any(|e| e["type"] == "error" && (e["summary"] == shown || e["detail"] == shown))));
                        task.set_state("failed", Some(&shown));
                        if !already {
                            task.append(evt("error", shown, None, None), 0);
                        }
                    }
                }
            }
        }
    }
    finish_task(&task).await;
}

fn system_prompt(start: &ApiStart) -> String {
    let mode_line = match start.tool_mode.as_str() {
        "read-only" => "Tool mode: READ ONLY. You may inspect files and tracker data, but must not change files, run commands, or mutate tickets.",
        "project-only" => "Tool mode: PROJECT ONLY. You do not have local file or shell tools. Converse directly with the user.",
        _ => "Tool mode: FULL. Use the available tools as needed; mutating operations require user approval.",
    };
    let mut prompt = format!("{}\n\n{mode_line}", praxis_ai::session::prompt::build_system_prompt(&start.task, &start.issue));
    if start.permission_mode.as_deref() == Some("autopilot") {
        prompt.push_str(&format!("\n\n{}", praxis_ai::session::prompt::prompt("AUTOPILOT_SESSION_PROMPT")));
    }
    prompt
}

fn initial_prompt(start: &ApiStart) -> String {
    let key = start.issue["key"].as_str().unwrap_or_default();
    if start.task["sessionMode"] == "chat" {
        return format!("Respond directly to the user's request. Do not start a ticket analysis or inspect a ticket unless the user explicitly asks you to.\n\nUser request: {}", start.task["goal"].as_str().unwrap_or_default());
    }
    let worktree = start.working_directory.as_deref().filter(|w| !w.is_empty()).map(|w| format!("\nWorktree (run ALL git and build commands from here): {w}")).unwrap_or_default();
    let shown = praxis_ai::session::prompt::reviewed_issue_key(key).unwrap_or_else(|| key.to_owned());
    format!("Execute the task described in the system prompt.\n\nIssue: {shown} — {}{worktree}", start.issue["summary"].as_str().unwrap_or_default())
}

/// Creates the session record and runs the loop in the background. Returns the session id.
pub fn start_api_task(host: &HostContext, dir: &std::path::Path, start: ApiStart) -> Result<String> {
    let key = start.issue["key"].as_str().unwrap_or_default().to_owned();
    if super::acp_host::has_active_task(dir, &key) {
        super::acp_host::abort_task(host, dir, &key);
    }
    let sessions = store(dir);
    let session_id = uuid::Uuid::new_v4().to_string();
    let started_at = now();
    let mode = start.task["sessionMode"].as_str().map(str::to_owned).unwrap_or_else(|| match start.task["kind"].as_str() { Some("analysis") => "analysis".into(), Some("review") => "review".into(), _ => "chat".into() });
    let goal_line = start.task["goal"].as_str().unwrap_or_default().lines().next().unwrap_or_default().trim().chars().take(120).collect::<String>();
    let mut record = json!({
        "issueKey": key, "sessionId": session_id, "provider": start.connection.provider, "model": start.model, "toolMode": start.tool_mode,
        "state": "not_started", "taskDefinition": start.task, "purpose": if goal_line.is_empty() { key.clone() } else { goal_line },
        "handoverBrief": { "updatedAt": started_at, "revision": 0 }, "runtimeEpochs": [{ "provider": start.connection.provider, "model": start.model, "startedAt": started_at }],
        "mode": mode, "events": [], "eventsLoaded": true, "eventCount": 0, "stepCount": 0, "startedAt": started_at,
        "reasoningEffort": start.reasoning_effort.clone().unwrap_or_else(|| "medium".into())
    });
    if let Some(working) = start.working_directory.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        record["workingDirectory"] = json!(working);
    }
    if start.auto_approve {
        record["autoApprovePermissions"] = json!(true);
    }
    if let Some(mode) = &start.permission_mode {
        record["permissionMode"] = json!(mode);
    }
    let cost_before = sessions.get(&key)?.and_then(|r| Some(r["cost"].clone()).filter(|c| !c.is_null()));
    sessions.put(&key, record.clone())?;
    let working_directory = start.working_directory.clone().map(PathBuf::from).or_else(|| std::env::current_dir().ok()).unwrap_or_default();
    let task = register_api_task(host, dir, &key, &session_id, &start.tool_mode, working_directory, start.auto_approve, start.permission_mode.as_deref() == Some("auto"), cost_before);
    host.events().emit("ai:sessionChanged", Some(record));
    task.set_state("planning", None);
    task.append(evt("session_start", format!("{} agent session started", start.connection.label), None, None), 0);
    note_context_limit(&task, &start.connection, &start.model);

    let max_steps = start.task["maxSteps"].as_u64().unwrap_or(500);
    let timeout = start.task["timeoutMs"].as_u64().map_or(Duration::from_secs(3 * 60 * 60), Duration::from_millis);
    let system = system_prompt(&start);
    let mut first = WireMessage::text(WireRole::User, initial_prompt(&start));
    let images: Vec<praxis_ai::providers::wire::WireImageAttachment> = start.images.iter().filter_map(|i| serde_json::from_value(i.clone()).ok()).collect();
    if !images.is_empty() {
        first.images = Some(images);
    }
    let (connection, model, tool_mode, reasoning) = (start.connection.clone(), start.model.clone(), start.tool_mode.clone(), start.reasoning_effort.clone());
    let runner = Arc::clone(&task);
    runtime().spawn(async move { run_session(runner, connection, model, system, vec![first], tool_mode, max_steps, timeout, reasoning).await });
    Ok(session_id)
}

/// A follow-up turn on an API session, continuing from the saved conversation history.
pub fn continue_api_task(host: &HostContext, dir: &std::path::Path, key: &str, message: &str, images: Vec<Value>, connection: ApiConnection) -> Result<()> {
    if super::acp_host::has_active_task(dir, key) {
        return Err(failure(format!("The agent is still working on {key}.")));
    }
    let sessions = store(dir);
    let record = sessions.get(key)?.ok_or_else(|| failure(format!("No agent session found for {key}.")))?;
    let follow_up = message.trim().to_owned();
    if follow_up.is_empty() {
        return Err(failure("Enter a follow-up message."));
    }
    let tool_mode = record["toolMode"].as_str().unwrap_or("full").to_owned();
    let model = record["model"].as_str().unwrap_or_default().to_owned();
    let issue = json!({ "key": key, "summary": record["taskDefinition"]["goal"], "issueType": "Task", "status": "In progress", "description": record["taskDefinition"]["scope"] });
    let start = ApiStart { issue, task: record["taskDefinition"].clone(), model: model.clone(), reasoning_effort: record["reasoningEffort"].as_str().map(str::to_owned), working_directory: record["workingDirectory"].as_str().map(str::to_owned), tool_mode: tool_mode.clone(), permission_mode: record["permissionMode"].as_str().map(str::to_owned), auto_approve: record["autoApprovePermissions"] == true, images: images.clone(), connection: connection.clone() };
    let system = system_prompt(&start);
    let mut history = history_from_record(&record);
    let mut turn = WireMessage::text(WireRole::User, follow_up.clone());
    let attachments: Vec<praxis_ai::providers::wire::WireImageAttachment> = images.iter().filter_map(|i| serde_json::from_value(i.clone()).ok()).collect();
    if !attachments.is_empty() {
        turn.images = Some(attachments);
    }
    history.push(turn);
    let working_directory = start.working_directory.clone().map(PathBuf::from).or_else(|| std::env::current_dir().ok()).unwrap_or_default();
    let session_id = record["sessionId"].as_str().unwrap_or_default().to_owned();
    let task = register_api_task(host, dir, key, &session_id, &tool_mode, working_directory, record["autoApprovePermissions"] == true, record["permissionMode"] == "auto", Some(record["cost"].clone()).filter(|c| !c.is_null()));
    task.mutate(true, |record| {
        record["responseText"] = json!("");
        record["reasoningText"] = json!("");
    });
    let mut event = evt("user_input_completed", "You", Some(follow_up), None);
    if !images.is_empty() {
        event["attachments"] = json!(images);
    }
    task.append(event, 0);
    task.set_state("executing", None);
    let max_steps = record["taskDefinition"]["maxSteps"].as_u64().unwrap_or(500);
    let timeout = record["taskDefinition"]["timeoutMs"].as_u64().map_or(Duration::from_secs(3 * 60 * 60), Duration::from_millis);
    let reasoning = start.reasoning_effort.clone();
    let runner = Arc::clone(&task);
    runtime().spawn(async move { run_session(runner, connection, model, system, history, tool_mode, max_steps, timeout, reasoning).await });
    Ok(())
}

// Keep the failure helper reachable for the delegate's error reporting.
#[allow(dead_code)]
pub(super) fn report(task: &Task, message: String) {
    fail(task, message);
}


/// One no-tools completion (`runProviderPrompt`): a system prompt and a single user prompt, streamed
/// and collected. Used by the Virtual Team assistant for text-only turns.
pub(super) async fn run_provider_prompt(connection: &ApiConnection, model: &str, system: &str, prompt: &str, reasoning: Option<&str>, on_text: impl FnMut(&str)) -> std::result::Result<(String, TokenUsage), String> {
    let wire_model = model.strip_prefix("Vercel/").unwrap_or(model).to_owned();
    let messages = vec![WireMessage::text(WireRole::System, system.to_owned()), WireMessage::text(WireRole::User, prompt.to_owned())];
    let body = match connection.wire {
        Wire::OpenAi => {
            let mut request = build_chat_request(&messages, &wire_model, &ChatRequestOptions { tools: Vec::new(), stream: true, ..ChatRequestOptions::default() }).body;
            if !connection.stream_usage {
                request.as_object_mut().map(|o| o.remove("stream_options"));
            }
            apply_openai_reasoning(&mut request, &wire_model, reasoning);
            request
        }
        Wire::Anthropic => {
            let mut request = anthropic_request_body(&messages, &wire_model, &AnthropicRequestOptions { tools: Vec::new(), reasoning_effort: parse_effort(reasoning), ..AnthropicRequestOptions::default() });
            request["stream"] = json!(true);
            request
        }
        Wire::Gemini => gemini_request_body(&messages, &GeminiRequestOptions { tools: Vec::new(), ..GeminiRequestOptions::default() }),
    };
    let sse = post_stream(connection, &wire_model, &body).await?;
    let result = collect(connection, sse, on_text).await?;
    Ok((result.text, result.usage))
}
