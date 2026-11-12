//! Tool, MCP and outcome signals read from a session transcript (port of `executionSignals.ts`).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use super::grounding::pick_test_command;
use super::types::{DimensionScore, Finding, Remediation, StepRef, WorkspaceHints, js_round, locale_cmp};

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static pattern"))
}

macro_rules! lazy_re {
    ($name:ident, $pattern:expr) => {
        fn $name() -> &'static Regex {
            static CELL: OnceLock<Regex> = OnceLock::new();
            re(&CELL, $pattern)
        }
    };
}

lazy_re!(shell_search, r"(?i)\b(grep|rg|ripgrep|find|ack|ag)\b");
lazy_re!(shell_tracker, r"(?i)\b(gh\s+issue|glab\s+issue|jira\s+issue|curl\b.*/issues)\b");
lazy_re!(verification_shell, r"(?i)\b(test|tsc|check-types|compile|build|playwright|vitest|jest|mocha|pytest|cargo\s+test|dotnet\s+test|go\s+test|npm\s+run\s+(?:test|build|check))\b");
lazy_re!(write_tool, r"(?i)\b(write_file|edit_file|edit|create_file|patch|str_replace|apply_patch|multiedit)\b");
lazy_re!(read_search_tool, r"\b(read_file|read|view|list_dir|search|grep|glob|find_symbol|search_code|get_source)\b");
lazy_re!(edit_in_place_tool, r"(?i)\b(edit_file|edit|str_replace|str_replace_editor|multiedit|apply_patch|patch|replace)\b");
lazy_re!(subagent_tool, r"(?i)^(task|agent|subagent|delegate|spawn_agent)$");
lazy_re!(shell_read, r"\b(cat|sed|head|tail|less|grep|rg|nl|awk)\b");
lazy_re!(path_like, r"[\w@./-]+\.[A-Za-z0-9]{1,6}\b");
lazy_re!(failed_type, r"(?i)failed|error");
lazy_re!(undo_edit, r"(?i)You undid the edit to");

fn is_mcp_or_structured(tool: &str) -> bool {
    let lower = tool.to_lowercase();
    ["mcp__", "mcp_", "code_intelligence", "tracker_", "browser_"].iter().any(|p| lower.starts_with(p))
        || ["find_symbol", "search_code", "get_callers", "get_callees", "trace_flow", "search_knowledge"].contains(&lower.as_str())
}

pub fn file_name(path: &str) -> String {
    let last = path.rsplit(['/', '\\']).next().unwrap_or_default();
    if last.is_empty() { path.to_owned() } else { last.to_owned() }
}

fn one_line(text: Option<&str>, max: usize) -> Option<String> {
    let clean = text?.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        return None;
    }
    Some(if clean.chars().count() > max { format!("{}…", clean.chars().take(max - 1).collect::<String>()) } else { clean })
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key].as_str()
}

fn arg_path(args: &Value) -> Option<String> {
    ["path", "file_path", "filePath", "Path", "target_file", "file", "notebook_path"]
        .iter()
        .find_map(|key| args[*key].as_str().map(str::trim).filter(|v| !v.is_empty()))
        .map(str::to_owned)
}

#[derive(Debug, Clone, Default)]
struct ToolCall {
    step: usize,
    tool_name: String,
    ok: Option<bool>,
    call_id: Option<String>,
    timestamp: Option<String>,
    detail: Option<String>,
    error: Option<String>,
    path: Option<String>,
    changed_paths: Vec<String>,
    read_names: Vec<String>,
    command: String,
    command_arg: Option<String>,
    is_write: bool,
    is_edit_in_place: bool,
    is_read: bool,
    is_search: bool,
    is_shell: bool,
}

fn step_ref(call: &ToolCall) -> StepRef {
    StepRef {
        step: call.step,
        tool_name: call.tool_name.clone(),
        detail: call.detail.clone(),
        ok: call.ok,
        call_id: call.call_id.clone(),
        timestamp: call.timestamp.clone(),
        error: call.error.clone(),
    }
}

fn step_refs(calls: &[&ToolCall]) -> Vec<StepRef> {
    calls.iter().map(|c| step_ref(c)).collect()
}

fn format_step_range(calls: &[&ToolCall]) -> String {
    let steps: Vec<usize> = calls.iter().map(|c| c.step).collect();
    if steps.len() >= 3 && steps.windows(2).all(|w| w[1] > w[0]) {
        return format!("#{}–#{}", steps[0], steps[steps.len() - 1]);
    }
    steps.iter().map(|s| format!("#{s}")).collect::<Vec<_>>().join(", ")
}

fn is_shell_event(data: &Value) -> bool {
    let tool = data["toolName"].as_str().unwrap_or_default().to_lowercase();
    data["kind"] == "shell" || ["run_shell", "run_command", "bash", "shell", "execute"].contains(&tool.as_str())
}

fn is_write_event(data: &Value) -> bool {
    let tool = data["toolName"].as_str().unwrap_or_default().to_lowercase();
    data["kind"] == "write" || write_tool().is_match(&tool) || data["fileChanges"].as_array().is_some_and(|c| !c.is_empty())
}

fn shell_command_text(event: &Value, data: &Value) -> String {
    let args = &data["args"];
    let from_args = ["command", "cmd", "CommandLine"].iter().find_map(|k| args[*k].as_str()).unwrap_or_default();
    [from_args, data["argsSummary"].as_str().unwrap_or_default(), event["summary"].as_str().unwrap_or_default(), event["detail"].as_str().unwrap_or_default()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_call(event: &Value, index: usize, start: Option<&Value>) -> ToolCall {
    let mut data = Map::new();
    if let Some(Value::Object(s)) = start.map(|s| &s["data"]) {
        data.extend(s.clone());
    }
    if let Value::Object(e) = &event["data"] {
        data.extend(e.clone());
    }
    let start_args = start.map(|s| &s["data"]["args"]).filter(|a| !a.is_null());
    let args = start_args.or_else(|| Some(&event["data"]["args"]).filter(|a| !a.is_null())).cloned().unwrap_or(Value::Null);
    if !args.is_null() {
        data.insert("args".into(), args.clone());
    }
    let data = Value::Object(data);
    let tool_name = {
        let named = data["toolName"].as_str().unwrap_or_default().trim().to_owned();
        if named.is_empty() { data["kind"].as_str().unwrap_or("tool").to_owned() } else { named }
    };
    let is_shell = is_shell_event(&data);
    let command = if is_shell { shell_command_text(event, &data) } else { String::new() };
    let command_arg = ["command", "cmd", "CommandLine"].iter().find_map(|k| args[*k].as_str().filter(|v| !v.trim().is_empty())).map(|v| v.trim().to_owned());
    let changed_paths: Vec<String> = data["fileChanges"].as_array().into_iter().flatten().filter_map(|c| c["path"].as_str().filter(|p| !p.is_empty()).map(str::to_owned)).collect();
    let args_summary = str_of(&data, "argsSummary").or_else(|| start.and_then(|s| s["data"]["argsSummary"].as_str()));
    let summary = one_line(args_summary, 120);
    let path = arg_path(&args).or_else(|| changed_paths.first().cloned()).or_else(|| summary.as_deref().and_then(|s| path_like().find(s)).map(|m| m.as_str().to_owned()));
    let detail = summary.clone().or_else(|| path.clone()).or_else(|| command_arg.as_deref().and_then(|c| one_line(Some(c), 120)));
    let is_write = is_write_event(&data);
    let kind = data["kind"].as_str().unwrap_or_default();
    let is_read = !is_write && (kind == "read" || kind == "list" || read_search_tool().is_match(&tool_name));
    let is_search = !is_write && kind == "search";
    let failed = data["ok"] == false || failed_type().is_match(event["type"].as_str().unwrap_or_default());
    let mut read_names = Vec::new();
    if (is_read || is_search) && let Some(p) = &path {
        read_names.push(file_name(p));
    }
    if !command.is_empty() && shell_read().is_match(&command) {
        read_names.extend(path_like().find_iter(&command).map(|m| file_name(m.as_str())));
    }
    let edit_in_place = is_write && if kind == "write" { edit_in_place_tool().is_match(&tool_name) || tool_name == "write" } else { edit_in_place_tool().is_match(&tool_name) };
    ToolCall {
        step: index + 1,
        tool_name,
        ok: if failed { Some(false) } else if data["ok"] == true { Some(true) } else { None },
        call_id: str_of(&data, "callId").filter(|c| !c.is_empty()).map(str::to_owned),
        timestamp: event["timestamp"].as_str().filter(|t| !t.is_empty()).map(str::to_owned),
        detail,
        error: if failed { one_line(data["output"].as_str().or_else(|| event["detail"].as_str()), 160) } else { None },
        path,
        changed_paths,
        read_names,
        command_arg,
        is_write,
        is_edit_in_place: edit_in_place,
        is_read: is_read || (!command.is_empty() && shell_read().is_match(&command) && !shell_search().is_match(&command)),
        is_search,
        is_shell,
        command,
    }
}

fn collect_tool_calls(events: &[Value]) -> Vec<ToolCall> {
    let mut calls = Vec::new();
    let mut open: Vec<(ToolCall, &Value)> = Vec::new();
    for (index, event) in events.iter().enumerate() {
        match event["type"].as_str() {
            Some("tool_start") => open.push((build_call(event, index, None), event)),
            Some("tool_complete") => {
                let call_id = event["data"]["callId"].as_str().filter(|c| !c.is_empty());
                let position = open.iter().position(|(_, e)| match call_id {
                    Some(id) => e["data"]["callId"].as_str() == Some(id),
                    None => e["data"]["toolName"] == event["data"]["toolName"],
                });
                let start = position.map(|p| open.remove(p).1);
                calls.push(build_call(event, index, start));
            }
            _ => {}
        }
    }
    calls.extend(open.into_iter().map(|(call, _)| call));
    calls.sort_by_key(|c| c.step);
    calls
}

/// Slices events to a single turn when `turn_index` is given, or returns all events.
pub fn select_turn_events(events: &[Value], turn_index: Option<usize>) -> Vec<Value> {
    let Some(turn_index) = turn_index else { return events.to_vec() };
    let mut turns: Vec<Vec<Value>> = Vec::new();
    let mut current: Vec<Value> = Vec::new();
    for event in events {
        if event["type"] == "user_input_completed" && !current.is_empty() {
            turns.push(std::mem::take(&mut current));
        }
        current.push(event.clone());
    }
    if !current.is_empty() {
        turns.push(current);
    }
    turns.into_iter().nth(turn_index).unwrap_or_else(|| events.to_vec())
}

#[derive(Debug, Clone)]
pub struct ExecutionAnalysis {
    pub tool_dimension: DimensionScore,
    pub mcp_dimension: DimensionScore,
    pub outcome_dimension: DimensionScore,
    pub findings: Vec<Finding>,
    pub tools_used: Vec<String>,
    pub mcp_tools_used: Vec<String>,
    pub total_tool_calls: usize,
    pub successful_tool_calls: usize,
    pub failed_tool_calls: usize,
    pub retry_loop_count: usize,
    pub shell_search_fallback_count: usize,
    pub touched_paths: Vec<String>,
    pub has_post_edit_verification: bool,
    pub blind_edit_count: usize,
    pub failed_edit_count: usize,
    pub last_write_step: Option<usize>,
    pub path_write_steps: BTreeMap<String, StepRef>,
}

pub struct ExecutionInput<'a> {
    pub kind: &'a str,
    pub prompt_text: &'a str,
    pub session: Option<&'a Value>,
    pub turn_index: Option<usize>,
    pub configured_mcp_servers: &'a [String],
    pub code_intelligence_available: Option<bool>,
    pub tracker_tools_available: bool,
    pub user_feedback: Option<&'a Value>,
    pub workspace_hints: Option<&'a WorkspaceHints>,
}

fn dimension(id: &str, label: &str, earned: i64, max: i64, summary: String) -> DimensionScore {
    DimensionScore { dimension: id.into(), label: label.into(), earned_points: earned, max_points: max, normalized_score: js_round(earned as f64 / max as f64 * 100.0), summary, signals: None }
}

struct FailedGroup<'a> {
    calls: Vec<&'a ToolCall>,
    blind: bool,
    resolved_by: Option<&'a ToolCall>,
    read_before_resolve: bool,
}

#[allow(clippy::too_many_lines)]
pub fn analyze(input: &ExecutionInput<'_>) -> ExecutionAnalysis {
    let mut findings: Vec<Finding> = Vec::new();
    let configured: BTreeSet<String> = input.configured_mcp_servers.iter().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
    let has_code_intel = input.code_intelligence_available != Some(false);
    let has_tracker = input.tracker_tools_available || input.session.is_some_and(|s| s["connectionId"].as_str().is_some_and(|c| !c.is_empty()));

    let session = match input.session {
        Some(session) if input.kind != "prompt-readiness" => session,
        _ => {
            let mcp_max = 15;
            let mut mcp_earned = 15;
            if re_text(r"(?i)\b(use grep|run grep|run find|use curl)\b", input.prompt_text.trim()) && has_code_intel {
                mcp_earned -= 5;
                findings.push(Finding::new(
                    "prompt-shell-search-instead-of-mcp", "mcp-leverage", "info", -5,
                    "Prompt asks for raw shell search instead of Code Intelligence MCP",
                    "Prompt explicitly instructs running `grep`/`find`/`curl` while structured `code_intelligence` tools are available.",
                    Remediation::new("enable-mcp", "Prefer code_intelligence Tools", "Use `find_symbol`, `search_code`, or `search_knowledge` instead of raw shell `grep`.")
                        .target("code_intelligence")
                        .snippet("Use `code_intelligence` (`find_symbol`, `search_code`) for symbol and codebase lookups."),
                ));
            }
            let ready_list: Vec<String> = std::iter::once(if has_code_intel { "code_intelligence".to_owned() } else { String::new() }).chain(configured.iter().cloned()).filter(|s| !s.is_empty()).collect();
            let summary = if mcp_earned == mcp_max {
                format!("Ready ({}).", if ready_list.is_empty() { "standard tools".to_owned() } else { ready_list.join(", ") })
            } else {
                findings.iter().map(|f| f.title.clone()).collect::<Vec<_>>().join("; ")
            };
            return ExecutionAnalysis {
                tool_dimension: dimension("tool-efficiency", "Tool & Execution Efficiency", 25, 25, "Pre-send check (evaluated after session execution).".into()),
                mcp_dimension: dimension("mcp-leverage", "MCP & Capability Readiness", mcp_earned, mcp_max, summary),
                outcome_dimension: dimension("outcome-verification", "Outcome & Verification", 20, 20, "Pre-send check (evaluated after session execution).".into()),
                findings,
                tools_used: Vec::new(),
                mcp_tools_used: Vec::new(),
                total_tool_calls: 0,
                successful_tool_calls: 0,
                failed_tool_calls: 0,
                retry_loop_count: 0,
                shell_search_fallback_count: 0,
                touched_paths: Vec::new(),
                has_post_edit_verification: false,
                blind_edit_count: 0,
                failed_edit_count: 0,
                last_write_step: None,
                path_write_steps: BTreeMap::new(),
            };
        }
    };

    let all_events: Vec<Value> = session["events"].as_array().cloned().unwrap_or_default();
    let events = select_turn_events(&all_events, input.turn_index);
    let calls = collect_tool_calls(&events);
    let mut tools_used = BTreeSet::new();
    let mut mcp_tools_used = BTreeSet::new();
    let mut touched = BTreeSet::new();
    let mut path_write_steps: BTreeMap<String, StepRef> = BTreeMap::new();

    let permission_requests = events.iter().filter(|e| e["type"] == "permission_requested").count();
    let undo_edits = events.iter().filter(|e| e["type"] == "info" && undo_edit().is_match(e["summary"].as_str().unwrap_or_default())).count();

    let mut successful = 0usize;
    let mut failed_calls = 0usize;
    let mut mcp_failed = 0usize;
    let mut read_or_search = 0usize;
    let mut write_count = 0usize;
    let mut last_write: Option<&ToolCall> = None;
    let mut last_success_verification: Option<&ToolCall> = None;
    let mut last_verification_attempt: Option<&ToolCall> = None;
    let mut shell_search_calls: Vec<&ToolCall> = Vec::new();
    let mut shell_tracker_fallbacks = 0usize;
    let mut used_subagent = false;

    let mut read_names: BTreeSet<String> = BTreeSet::new();
    let mut open_runs: BTreeMap<String, (Vec<&ToolCall>, bool)> = BTreeMap::new();
    let mut groups: Vec<FailedGroup<'_>> = Vec::new();
    let mut isolated_blind: Vec<&ToolCall> = Vec::new();
    let mut writes_by_name: BTreeMap<String, Vec<&ToolCall>> = BTreeMap::new();

    for call in &calls {
        tools_used.insert(call.tool_name.clone());
        let structured = is_mcp_or_structured(&call.tool_name);
        if structured {
            mcp_tools_used.insert(call.tool_name.clone());
        }
        if subagent_tool().is_match(&call.tool_name) {
            used_subagent = true;
        }
        if call.ok == Some(false) {
            failed_calls += 1;
            if structured {
                mcp_failed += 1;
            }
        } else {
            successful += 1;
        }
        let name = call.path.as_deref().map(file_name);

        if call.is_write {
            for changed in &call.changed_paths {
                touched.insert(changed.clone());
            }
            if let Some(p) = &call.path {
                touched.insert(p.clone());
            }
            if let Some(name) = &name {
                let blind = call.is_edit_in_place && !read_names.contains(name);
                if call.ok == Some(false) {
                    let run = open_runs.entry(name.clone()).or_insert_with(|| (Vec::new(), blind));
                    run.0.push(call);
                } else {
                    if let Some(run) = open_runs.remove(name) {
                        if run.0.len() >= 2 {
                            groups.push(FailedGroup { calls: run.0, blind: run.1, resolved_by: Some(call), read_before_resolve: read_names.contains(name) });
                        }
                    } else if blind {
                        isolated_blind.push(call);
                    }
                    writes_by_name.entry(name.clone()).or_default().push(call);
                    if let Some(p) = &call.path {
                        path_write_steps.entry(p.clone()).or_insert_with(|| step_ref(call));
                    }
                }
            }
            if call.ok != Some(false) {
                write_count += 1;
                last_write = Some(call);
            }
            continue;
        }

        if call.is_read || call.is_search {
            read_or_search += 1;
            for n in &call.read_names {
                read_names.insert(n.clone());
            }
            for n in &call.read_names {
                if open_runs.get(n).is_some_and(|run| run.0.len() < 2) {
                    open_runs.remove(n);
                }
            }
        }

        if call.is_shell {
            let cmd = &call.command;
            if shell_search().is_match(cmd) && !verification_shell().is_match(cmd) {
                shell_search_calls.push(call);
            }
            if shell_tracker().is_match(cmd) {
                shell_tracker_fallbacks += 1;
            }
            if verification_shell().is_match(cmd) {
                last_verification_attempt = Some(call);
                if call.ok != Some(false) {
                    last_success_verification = Some(call);
                }
            }
        }
    }
    for (_, run) in std::mem::take(&mut open_runs) {
        if run.0.len() >= 2 {
            groups.push(FailedGroup { calls: run.0, blind: run.1, resolved_by: None, read_before_resolve: false });
        }
    }

    let attributed: BTreeSet<usize> = groups.iter().flat_map(|g| g.calls.iter().map(|c| c.step)).collect();

    // Tool & execution efficiency (25)
    let tool_max = 25;
    let mut tool_earned = tool_max;
    let total = calls.len();

    let mut ranked: Vec<&FailedGroup<'_>> = groups.iter().collect();
    ranked.sort_by(|a, b| b.calls.len().cmp(&a.calls.len()).then(a.calls[0].step.cmp(&b.calls[0].step)));
    for group in ranked.iter().take(2) {
        let first = group.calls[0];
        let name = file_name(first.path.as_deref().unwrap_or_default());
        let count = group.calls.len();
        let deduction = std::cmp::min(8, 2 + count as i64 * 2);
        tool_earned -= deduction;
        let recovery = match group.resolved_by {
            Some(by) if group.read_before_resolve => format!(" and only succeeded after reading it on step #{}.", by.step),
            Some(by) => format!("; step #{} finally applied it.", by.step),
            None => " and never recovered.".to_owned(),
        };
        let error_note = first.error.as_ref().map_or(String::new(), |e| format!(" Error: {e}"));
        let path = first.path.clone().unwrap_or_default();
        findings.push(
            Finding::new(
                format!("{}:{name}", if group.blind { "tool-blind-edit-loop" } else { "tool-edit-retry-loop" }),
                "tool-efficiency", "critical", -deduction,
                if group.blind { format!("Blind edit failed {count}× on `{name}`") } else { format!("`{}` failed {count}× in a row on `{name}`", first.tool_name) },
                if group.blind {
                    format!("Called `{}` {count} times before reading the file{recovery}{error_note}", first.tool_name)
                } else {
                    format!("Retried the same edit without re-reading the current file contents{recovery}{error_note}")
                },
                Remediation::new("pin-file", format!("Pin @{name}"), format!("Have the next turn read `{path}` before editing it."))
                    .target(path.clone())
                    .snippet(format!("Read @{path} before editing it.")),
            )
            .with_steps(step_refs(&group.calls)),
        );
    }

    if !isolated_blind.is_empty() {
        let deduction = std::cmp::min(4, isolated_blind.len() as i64 * 2);
        tool_earned -= deduction;
        let mut names: Vec<String> = Vec::new();
        for call in &isolated_blind {
            let n = file_name(call.path.as_deref().unwrap_or_default());
            if !names.contains(&n) {
                names.push(n);
            }
        }
        findings.push(
            Finding::new(
                "tool-blind-edits", "tool-efficiency", "info", -deduction,
                format!("{} {} made without reading the file first", isolated_blind.len(), if isolated_blind.len() == 1 { "edit" } else { "edits" }),
                format!("Edited {} without a prior read, so the change was applied to contents the agent had not seen.", names.iter().take(3).map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ")),
                Remediation::new("avoid-tool-pattern", "Read before editing", "Read the target section of a file before editing it in place.").snippet("Read each file before editing it."),
            )
            .with_steps(step_refs(&isolated_blind)),
        );
    }

    let thrashed = writes_by_name.iter().filter(|(_, w)| w.len() >= 5).max_by(|a, b| a.1.len().cmp(&b.1.len()).then_with(|| locale_cmp(b.0, a.0)));
    if let Some((name, writes)) = thrashed {
        tool_earned -= 3;
        let target = writes[0].path.clone().unwrap_or_else(|| name.clone());
        findings.push(
            Finding::new(
                format!("tool-file-thrash:{name}"), "tool-efficiency", "warning", -3,
                format!("Edited `{name}` {}× in one {}", writes.len(), if input.turn_index.is_some() { "turn" } else { "session" }),
                "Repeated small edits to the same file suggest the change was not planned before editing.",
                Remediation::new("refine-prompt", "Plan, then edit once", format!("Plan all changes to `{target}` first, then apply them in one pass and typecheck once."))
                    .snippet(format!("Plan all changes to @{target} before editing, then apply them in one pass.")),
            )
            .with_steps(step_refs(writes)),
        );
    }

    let unattributed: Vec<&ToolCall> = calls.iter().filter(|c| c.ok == Some(false) && !attributed.contains(&c.step)).collect();
    if !unattributed.is_empty() && total > 0 {
        let rate = unattributed.len() as f64 / total as f64;
        let deduction = (js_round(rate * 15.0) + if unattributed.len() >= 3 { 2 } else { 0 }).clamp(2, 10);
        tool_earned -= deduction;
        let mut tool_names: Vec<&String> = Vec::new();
        for c in &unattributed {
            if !tool_names.contains(&&c.tool_name) {
                tool_names.push(&c.tool_name);
            }
        }
        let first = unattributed[0];
        findings.push(
            Finding::new(
                "tool-failed-calls", "tool-efficiency", if unattributed.len() >= 3 { "critical" } else { "warning" }, -deduction,
                if tool_names.len() == 1 { format!("`{}` failed {}×", tool_names[0], unattributed.len()) } else { format!("{} of {total} tool calls failed", unattributed.len()) },
                format!(
                    "First failure on step #{}{}{}",
                    first.step,
                    first.detail.as_ref().map_or(String::new(), |d| format!(" ({d})")),
                    first.error.as_ref().map_or_else(|| ".".to_owned(), |e| format!(": {e}"))
                ),
                Remediation::new("avoid-tool-pattern", "Inspect before retrying", "Read the error and the current state before calling the tool again.")
                    .snippet("If a tool call fails, read the error and inspect the current state before retrying."),
            )
            .with_steps(step_refs(&unattributed)),
        );

        let mut loop_steps: Vec<&ToolCall> = Vec::new();
        let mut streak: Vec<&ToolCall> = Vec::new();
        for call in &calls {
            if attributed.contains(&call.step) {
                continue;
            }
            if call.ok == Some(false) && streak.last().is_some_and(|p| p.tool_name == call.tool_name) {
                streak.push(call);
            } else {
                if streak.len() >= 3 {
                    loop_steps.append(&mut streak);
                }
                streak = if call.ok == Some(false) { vec![call] } else { Vec::new() };
            }
        }
        if streak.len() >= 3 {
            loop_steps.append(&mut streak);
        }
        if !loop_steps.is_empty() {
            let deduction = std::cmp::min(8, 1 + loop_steps.len() as i64 * 2);
            tool_earned -= deduction;
            findings.push(
                Finding::new(
                    "tool-retry-loop", "tool-efficiency", "critical", -deduction,
                    format!("`{}` retried {}× without changing approach", loop_steps[0].tool_name, loop_steps.len()),
                    format!("Steps {} repeated a failing call{}.", format_step_range(&loop_steps), loop_steps[0].detail.as_ref().map_or(String::new(), |d| format!(" ({d})"))),
                    Remediation::new("avoid-tool-pattern", "Break retry loops early", "Stop repeating identical failing tool calls; inspect file state or error output first."),
                )
                .with_steps(step_refs(&loop_steps)),
            );
        }
    }

    if read_or_search >= 25 && !used_subagent {
        tool_earned -= 3;
        findings.push(Finding::new(
            "tool-read-sprawl", "tool-efficiency", "info", -3,
            format!("{read_or_search} serial reads in the main context"),
            format!("Exploration ran {read_or_search} read/search calls in the main conversation instead of a delegated subagent."),
            Remediation::new("refine-prompt", "Delegate exploration", "Hand broad exploration to a research subagent and keep the main context for the change.")
                .snippet("Delegate broad codebase exploration to a subagent and report back only what matters."),
        ));
    } else if read_or_search > 12 && write_count > 0 && read_or_search as f64 / write_count.max(1) as f64 > 8.0 {
        tool_earned -= 4;
        findings.push(Finding::new(
            "tool-high-read-churn", "tool-efficiency", "info", -4,
            format!("High read/search-to-edit churn ({read_or_search} reads vs {write_count} edits)"),
            format!("Session executed {read_or_search} read/search calls for {write_count} file {}.", if write_count == 1 { "edit" } else { "edits" }),
            Remediation::new("refine-prompt", "Narrow Initial File Scope", "Include target file paths in the prompt or use `code_intelligence` to jump directly to definitions."),
        ));
    }

    if permission_requests >= 3 {
        tool_earned -= 3;
        findings.push(Finding::new(
            "tool-permission-friction", "tool-efficiency", "info", -3,
            format!("Repeated permission prompts ({permission_requests} requests)"),
            format!("Session paused {permission_requests} times waiting for tool approval."),
            Remediation::new("change-tool-mode", "Use Autopilot Permission Mode", "Switch permission policy to Autopilot when running trusted multi-step tasks."),
        ));
    }

    let max_steps = session["taskDefinition"]["maxSteps"].as_f64().unwrap_or(500.0);
    let step_count = session["stepCount"].as_f64().unwrap_or(0.0);
    if step_count > 0.0 && max_steps > 0.0 && step_count / max_steps >= 0.8 {
        tool_earned -= 3;
        findings.push(Finding::new(
            "tool-step-budget-exhaustion", "tool-efficiency", "warning", -3,
            format!("Near step-budget ceiling ({step_count}/{max_steps} steps)"),
            format!("Session consumed {}% of its step budget.", js_round(step_count / max_steps * 100.0)),
            Remediation::new("refine-prompt", "Split Into Focused Subtasks", "Decompose large multi-stage goals into smaller tasks or a governed workflow."),
        ));
    }
    let tool_earned = tool_earned.clamp(0, tool_max);

    // MCP & structured capability leverage (15)
    let mcp_max = 15;
    let mut mcp_earned = mcp_max;
    let shell_search_count = shell_search_calls.len();
    if shell_search_count > 0 && has_code_intel && mcp_tools_used.is_empty() {
        let deduction = std::cmp::min(10, 4 + shell_search_count as i64);
        mcp_earned -= deduction;
        findings.push(
            Finding::new(
                "mcp-shell-grep-workaround", "mcp-leverage", "warning", -deduction,
                format!("Shell `grep` used {shell_search_count}× while `code_intelligence` was online"),
                format!("Spawned {shell_search_count} shell {} (steps {}) instead of calling `find_symbol` / `search_code`.", if shell_search_count == 1 { "search" } else { "searches" }, format_step_range(&shell_search_calls)),
                Remediation::new("enable-mcp", "Prefer code_intelligence", "Prefer `search_code`, `find_symbol`, and `get_callers` over raw shell `grep`/`find`.")
                    .target("code_intelligence")
                    .snippet("Use `code_intelligence` (`find_symbol`, `search_code`) instead of shell `grep`."),
            )
            .with_steps(step_refs(&shell_search_calls)),
        );
    } else if shell_search_count >= 3 && has_code_intel {
        mcp_earned -= 4;
        findings.push(
            Finding::new(
                "mcp-partial-shell-search", "mcp-leverage", "info", -4,
                format!("Mixed {shell_search_count} raw shell searches with structured tools"),
                format!("Steps {} fell back to shell search.", format_step_range(&shell_search_calls)),
                Remediation::new("enable-mcp", "Prefer Structured Search", "Reach for `code_intelligence` first for symbol definitions and call hierarchies.").target("code_intelligence"),
            )
            .with_steps(step_refs(&shell_search_calls)),
        );
    }
    if shell_tracker_fallbacks > 0 && has_tracker {
        mcp_earned -= 5;
        findings.push(Finding::new(
            "mcp-shell-tracker-workaround", "mcp-leverage", "warning", -5,
            "Used shell CLI for issue tracking instead of `tracker_*` MCP tools",
            format!("Observed {shell_tracker_fallbacks} shell tracker CLI call(s) when built-in `tracker_get_ticket` / `tracker_transition_ticket` tools were available."),
            Remediation::new("enable-mcp", "Use tracker_* MCP Tools", "Use `tracker_get_ticket`, `tracker_update_ticket`, and `tracker_transition_ticket` for board operations.").target("tracker"),
        ));
    }
    if mcp_failed > 0 {
        let deduction = std::cmp::min(5, mcp_failed as i64 * 2);
        mcp_earned -= deduction;
        findings.push(Finding::new(
            "mcp-call-failures", "mcp-leverage", "warning", -deduction,
            format!("{mcp_failed} structured/MCP tool {} failed", if mcp_failed == 1 { "call" } else { "calls" }),
            format!("MCP or structured tool invocations returned {mcp_failed} error(s)."),
            Remediation::new("avoid-tool-pattern", "Check MCP Tool Schema", "Verify required MCP arguments (such as repository name or issueKey) before calling."),
        ));
    }
    let tags: Vec<&str> = input.user_feedback.map(|f| f["frictionTags"].as_array().into_iter().flatten().filter_map(Value::as_str).collect()).unwrap_or_default();
    let notes = input.user_feedback.and_then(|f| f["notes"].as_str()).map(str::trim).filter(|n| !n.is_empty());
    if tags.contains(&"missed-mcp") {
        mcp_earned -= 4;
        findings.push(Finding::new(
            "user-flagged-missed-mcp", "mcp-leverage", "warning", -4,
            "User feedback flagged missed MCP server / structured tool",
            notes.map_or_else(|| "User marked `missed-mcp` in session feedback.".to_owned(), |n| format!("User note: \"{n}\"")),
            Remediation::new("enable-mcp", "Name Required MCP in Prompt", "Explicitly instruct the agent which MCP server or tool to invoke first."),
        ));
    }
    let mcp_earned = mcp_earned.clamp(0, mcp_max);

    // Outcome & verification integrity (20)
    let outcome_max = 20;
    let mut outcome_earned = outcome_max;
    let has_post_edit_verification = write_count == 0 || matches!((last_success_verification, last_write), (Some(v), Some(w)) if v.step > w.step);
    let unresolved = last_verification_attempt.filter(|attempt| attempt.ok == Some(false) && last_success_verification.is_none_or(|v| v.step != attempt.step));
    let state = session["state"].as_str().unwrap_or_default();
    if state == "failed" {
        outcome_earned -= 10;
        findings.push(Finding::new(
            "outcome-session-failed", "outcome-verification", "critical", -10,
            "Session terminated in `failed` state",
            session["lastError"].as_str().filter(|e| !e.is_empty()).map_or_else(|| "Session ended with a failure state before completing the goal.".to_owned(), |e| format!("Terminal error: {e}")),
            Remediation::new("refine-prompt", "Retry With Scoped Recovery Prompt", "Address the terminal error or narrow the task scope before re-running."),
        ));
    } else if state == "aborted" {
        outcome_earned -= 6;
        findings.push(Finding::new(
            "outcome-session-aborted", "outcome-verification", "warning", -6,
            "Session was aborted before completion",
            "Execution was stopped mid-flight before reaching a verified terminal outcome.",
            Remediation::new("refine-prompt", "Resume With Focused Prompt", "Continue from the completed steps and state the remaining verification check."),
        ));
    }
    if let Some(attempt) = unresolved {
        outcome_earned -= 6;
        let command: String = attempt.command_arg.clone().or_else(|| attempt.detail.clone()).unwrap_or_else(|| attempt.tool_name.clone()).chars().take(80).collect();
        let label_command = if command.chars().count() > 32 { format!("{}…", command.chars().take(32).collect::<String>()) } else { command.clone() };
        findings.push(
            Finding::new(
                "outcome-unresolved-failure", "outcome-verification", "critical", -6,
                format!("`{command}` failed and was never fixed"),
                format!("Step #{} exited with a failure and the turn ended without a passing re-run{}", attempt.step, attempt.error.as_ref().map_or_else(|| ".".to_owned(), |e| format!(": {e}"))),
                Remediation::new("add-test-command", format!("Re-run {label_command}"), "Fix the failure and re-run the same command until it passes.")
                    .target(command.clone())
                    .snippet(format!("Fix the failure from `{command}` and re-run it until it passes.")),
            )
            .with_steps(vec![step_ref(attempt)]),
        );
    } else if write_count > 0 && !has_post_edit_verification && let Some(last) = last_write {
        outcome_earned -= 6;
        let touched_list: Vec<String> = touched.iter().cloned().collect();
        let test = pick_test_command(input.prompt_text, input.workspace_hints, &touched_list);
        let remediation = match test {
            Some(t) => Remediation::new("add-test-command", format!("Run {}", t.label), format!("Run `{}` after the final edit.", t.command))
                .target(t.command.clone())
                .snippet(format!("Run `{}` and fix anything it reports.", t.command)),
            None => Remediation::new("add-verification", "Run typecheck & tests", "Run the typecheck or relevant tests after the last file write.").snippet("Run the typecheck and the relevant tests after the final edit."),
        };
        findings.push(
            Finding::new(
                "outcome-unverified-writes", "outcome-verification", "warning", -6,
                format!("Final edit (step #{}) not followed by a test or typecheck", last.step),
                format!("Wrote {write_count} file {} ({}) and finished without running a check after the last write.", if write_count == 1 { "edit" } else { "edits" }, touched_list.iter().take(3).map(|p| file_name(p)).collect::<Vec<_>>().join(", ")),
                remediation,
            )
            .with_steps(vec![step_ref(last)]),
        );
    }
    if undo_edits > 0 {
        let deduction = std::cmp::min(6, undo_edits as i64 * 3);
        outcome_earned -= deduction;
        findings.push(Finding::new(
            "outcome-user-undid-edits", "outcome-verification", "warning", -deduction,
            format!("User reverted {undo_edits} agent file {}", if undo_edits == 1 { "edit" } else { "edits" }),
            format!("Transcript records {undo_edits} `undoToolFileChange` action(s) by the user."),
            Remediation::new("refine-prompt", "Constrain Allowed Files", "Specify which files may be modified and which files must remain untouched."),
        ));
    }
    if let Some(feedback) = input.user_feedback {
        match feedback["verdict"].as_str() {
            Some("failed-goal") => {
                outcome_earned -= 10;
                findings.push(Finding::new(
                    "user-verdict-failed-goal", "outcome-verification", "critical", -10,
                    "User rated session outcome as Failed Goal",
                    notes.map_or_else(|| "User submitted a `failed-goal` verdict.".to_owned(), |n| format!("User feedback: \"{n}\"")),
                    Remediation::new("refine-prompt", "Apply User Feedback to Follow-Up", notes.map_or_else(|| "Re-run with explicit acceptance criteria and recommended skills.".to_owned(), |n| format!("Address user feedback: {n}"))),
                ));
            }
            Some("needs-work") => {
                outcome_earned -= 5;
                findings.push(Finding::new(
                    "user-verdict-needs-work", "outcome-verification", "warning", -5,
                    "User rated session outcome as Needs Work",
                    notes.map_or_else(|| "User submitted a `needs-work` verdict.".to_owned(), |n| format!("User feedback: \"{n}\"")),
                    Remediation::new("refine-prompt", "Apply User Feedback to Follow-Up", notes.map_or_else(|| "Refine the follow-up prompt using the flagged friction items.".to_owned(), |n| format!("Address user feedback: {n}"))),
                ));
            }
            _ => {}
        }
        let extra: Vec<&str> = tags.iter().copied().filter(|t| ["wrong-scope", "ignored-instructions", "unverified-changes", "wasted-steps"].contains(t)).collect();
        if !extra.is_empty() {
            let deduction = std::cmp::min(6, extra.len() as i64 * 2);
            outcome_earned -= deduction;
            let joined = extra.join(", ");
            findings.push(Finding::new(
                "user-friction-tags", "outcome-verification", "warning", -deduction,
                format!("User flagged friction: {joined}"),
                notes.map_or_else(|| format!("User tagged session with: {joined}."), |n| format!("Tags [{joined}] — \"{n}\"")),
                Remediation::new("refine-prompt", "Tighten Guardrails in Follow-Up", format!("Add explicit constraints addressing: {joined}.")),
            ));
        }
    }
    let outcome_earned = outcome_earned.clamp(0, outcome_max);

    let tool_summary = if tool_earned == tool_max {
        format!("{total} tool {}, 0 failures, 0 retry loops.", if total == 1 { "call" } else { "calls" })
    } else {
        format!("{successful}/{total} succeeded · {failed_calls} failed.")
    };
    let mcp_list: Vec<String> = mcp_tools_used.iter().cloned().collect();
    let mcp_summary = if mcp_earned == mcp_max {
        if mcp_list.is_empty() { "No raw shell workarounds detected.".to_owned() } else { format!("Used structured MCP tools ({}).", mcp_list.iter().take(3).cloned().collect::<Vec<_>>().join(", ")) }
    } else {
        format!("{} MCP calls · {shell_search_count} raw shell search {}.", mcp_list.len(), if shell_search_count == 1 { "call" } else { "calls" })
    };
    let outcome_summary = if outcome_earned == outcome_max {
        "Session completed cleanly with verified changes.".to_owned()
    } else {
        findings.iter().filter(|f| f.dimension == "outcome-verification").map(|f| f.title.clone()).collect::<Vec<_>>().join("; ")
    };
    let retry_loop_count = findings.iter().filter(|f| f.id == "tool-retry-loop" || f.id.starts_with("tool-blind-edit-loop:") || f.id.starts_with("tool-edit-retry-loop:")).count();
    ExecutionAnalysis {
        tool_dimension: dimension("tool-efficiency", "Tool & Execution Efficiency", tool_earned, tool_max, tool_summary),
        mcp_dimension: dimension("mcp-leverage", "MCP & Capability Leverage", mcp_earned, mcp_max, mcp_summary),
        outcome_dimension: dimension("outcome-verification", "Outcome & Verification", outcome_earned, outcome_max, outcome_summary),
        tools_used: tools_used.into_iter().collect(),
        mcp_tools_used: mcp_list,
        total_tool_calls: total,
        successful_tool_calls: successful,
        failed_tool_calls: failed_calls,
        retry_loop_count,
        shell_search_fallback_count: shell_search_count,
        touched_paths: touched.into_iter().collect(),
        has_post_edit_verification,
        blind_edit_count: isolated_blind.len() + groups.iter().filter(|g| g.blind).count(),
        failed_edit_count: groups.iter().map(|g| g.calls.len()).sum(),
        last_write_step: last_write.map(|c| c.step),
        path_write_steps,
        findings,
    }
}

fn re_text(pattern: &str, text: &str) -> bool {
    Regex::new(pattern).is_ok_and(|r| r.is_match(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session() -> Value {
        json!({ "state": "completed", "stepCount": 5, "events": [
            { "type": "user_input_completed", "detail": "update docs/plans/feature.md" },
            { "type": "tool_complete", "data": { "toolName": "run_command", "ok": true, "args": { "command": "grep -rn \"Status\" docs/plans" } } },
            { "type": "tool_complete", "data": { "toolName": "edit_file", "ok": false, "args": { "path": "docs/plans/feature.md" } } },
            { "type": "tool_complete", "data": { "toolName": "edit_file", "ok": false, "args": { "path": "docs/plans/feature.md" } } },
            { "type": "tool_complete", "data": { "toolName": "edit_file", "ok": true, "args": { "path": "docs/plans/feature.md" }, "fileChanges": [{ "path": "docs/plans/feature.md" }] } },
        ] })
    }

    fn run(session: &Value, turn: Option<usize>) -> ExecutionAnalysis {
        analyze(&ExecutionInput {
            kind: "session-execution", prompt_text: "update docs/plans/feature.md", session: Some(session), turn_index: turn,
            configured_mcp_servers: &[], code_intelligence_available: Some(true), tracker_tools_available: false, user_feedback: None, workspace_hints: None,
        })
    }

    #[test]
    fn finds_the_blind_edit_loop_and_shell_grep() {
        let result = run(&session(), None);
        let ids: Vec<&str> = result.findings.iter().map(|f| f.id.as_str()).collect();
        assert!(ids.contains(&"tool-blind-edit-loop:feature.md"), "{ids:?}");
        assert!(ids.contains(&"mcp-shell-grep-workaround"));
        assert!(ids.contains(&"outcome-unverified-writes"));
        assert_eq!(result.failed_edit_count, 2);
        assert_eq!(result.blind_edit_count, 1);
        assert_eq!(result.shell_search_fallback_count, 1);
        let blind = result.findings.iter().find(|f| f.id.starts_with("tool-blind")).unwrap();
        assert_eq!(blind.title, "Blind edit failed 2× on `feature.md`");
        assert_eq!(blind.delta_points, -6);
    }

    #[test]
    fn turn_slicing_isolates_a_turn() {
        let mut s = session();
        s["events"].as_array_mut().unwrap().push(json!({ "type": "user_input_completed", "detail": "again" }));
        assert_eq!(select_turn_events(s["events"].as_array().unwrap(), Some(1)).len(), 1);
        assert_eq!(run(&s, Some(1)).total_tool_calls, 0);
    }

    #[test]
    fn prompt_readiness_has_no_execution_findings() {
        let result = analyze(&ExecutionInput {
            kind: "prompt-readiness", prompt_text: "use grep for it", session: None, turn_index: None, configured_mcp_servers: &[],
            code_intelligence_available: Some(true), tracker_tools_available: false, user_feedback: None, workspace_hints: None,
        });
        assert_eq!(result.findings[0].id, "prompt-shell-search-instead-of-mcp");
        assert_eq!(result.mcp_dimension.earned_points, 10);
    }
}
