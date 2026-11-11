//! `ai:delegate` and the session-control channels (`abort`, `respondToPermission`,
//! `setAcpMode`). Ports the handler in Electron's `aiIpc.ts`: validate, resolve the issue,
//! build the task contract, choose the working folder and tool mode, then launch the agent.
//!
//! These run outside the profile lock (see `Application::dispatch`): launching only spawns, and
//! an abort can take seconds, which must not freeze every other call.

use praxis_ai::providers::registry::{DescriptorKind, built_in_descriptors};
use praxis_host::HostContext;
use praxis_contracts::RustRpcRequest;
use serde_json::{Value, json};

use super::acp_host::{self, Continue, Decision, StartTask};
use super::session_store::store;
use super::{Result, failure, text};

pub const CHANNELS: [&str; 5] = ["ai:delegate", "ai:abort", "ai:respondToPermission", "ai:setAcpMode", "ai:continueSession"];

fn default_task(issue: &Value, overrides: &Value) -> Value {
    let summary = issue["summary"].as_str().unwrap_or_default();
    let description = issue["description"].as_str().filter(|d| !d.is_empty()).map(|d| format!("\n{}", d.chars().take(500).collect::<String>())).unwrap_or_default();
    let mut task = json!({
        "kind": "general",
        "goal": overrides["goal"].as_str().map_or_else(|| format!("{summary}{description}"), str::to_owned),
        "scope": overrides["scope"].as_str().unwrap_or("This issue and related files"),
        "definitionOfDone": overrides["definitionOfDone"].as_str().unwrap_or("All acceptance criteria met, code compiles, tests pass"),
    });
    for field in ["workflow", "maxSteps", "timeoutMs"] {
        if !overrides[field].is_null() && overrides[field] != json!(0) {
            task[field] = overrides[field].clone();
        }
    }
    task
}

/// The task contract of a read-only mode, shared with sessions started from the phone.
fn read_only_mode_task(mode: &str, issue: &Value, analysis_prompt: &str, goal: Option<&str>) -> Value {
    let (key, summary) = (issue["key"].as_str().unwrap_or_default(), issue["summary"].as_str().unwrap_or_default());
    if mode == "analysis" {
        let goal = goal.map_or_else(|| format!("Analyze {key} — {summary}."), str::to_owned);
        let full_goal = [analysis_prompt, goal.as_str(), "This is a read-only analysis; do not implement anything yet."].join("\n\n");
        return json!({
            "kind": "analysis", "sessionMode": "analysis",
            "goal": full_goal,
            "scope": "Read-only analysis of the supplied goal and relevant workspace context.",
            "definitionOfDone": "A clear analysis and ordered implementation plan is presented for review.",
            "nonGoals": ["Do not edit files or change external state during analysis."],
            "completionContract": "Stop after presenting the analysis and wait for confirmation."
        });
    }
    json!({
        "kind": "review", "sessionMode": "review",
        "goal": goal.map_or_else(|| format!("Review {key} — {summary}."), str::to_owned),
        "scope": "Read-only review of the supplied goal, implementation, tests, and relevant workspace context.",
        "definitionOfDone": "A concise review identifies strengths, risks, and actionable findings.",
        "nonGoals": ["Do not edit files or implement fixes during review."],
        "completionContract": "Stop after presenting review findings and wait for the user."
    })
}

fn build_mode_task(mode: &str, issue: &Value, analysis_prompt: &str, overrides: &Value) -> Value {
    if mode == "analysis" || mode == "review" {
        return read_only_mode_task(mode, issue, analysis_prompt, overrides["goal"].as_str());
    }
    let mut task = default_task(issue, overrides);
    task["sessionMode"] = json!("chat");
    task
}

fn host_call(host: &HostContext, channel: &str, args: Vec<Value>) -> Result<Value> {
    let response = host.dispatch_rpc(RustRpcRequest { id: "delegate".into(), channel: channel.into(), args });
    if response.ok { Ok(response.result.unwrap_or(Value::Null)) } else { Err(response.error.map_or_else(|| failure("The host returned no error."), |e| failure(e.message))) }
}

fn non_empty<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key].as_str().map(str::trim).filter(|v| !v.is_empty())
}

fn delegate(host: &HostContext, dir: &std::path::Path, args: &[Value]) -> Result<Value> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    let settings = host.settings().read();
    let ai = &settings.ai;
    let mode = input["mode"].as_str().unwrap_or(if input["purpose"] == "analysis" { "analysis" } else { "chat" }).to_owned();
    let is_analysis = mode == "analysis" || input["purpose"] == "analysis";
    let analysis_prompt = ai.analysis_prompt.trim().to_owned();
    if is_analysis && analysis_prompt.is_empty() {
        return Err(failure("Set an analysis system prompt under Settings → AI Provider first."));
    }
    let provider = non_empty(&input, "provider").map_or_else(|| ai.active_provider.clone(), str::to_owned);
    let custom_configs: Vec<Value> = ai.custom_providers.iter().flatten().filter_map(|c| serde_json::to_value(c).ok()).collect();
    let custom = custom_configs.iter().find(|c| c["id"] == provider).cloned();
    let builtin = built_in_descriptors().into_iter().find(|d| d.id == provider);
    let (kind, label, default_command, default_args) = match (&builtin, &custom) {
        (Some(d), _) => (d.kind, d.label.clone(), d.default_command.clone(), d.default_args.clone()),
        (None, Some(c)) => (DescriptorKind::Api, c["label"].as_str().unwrap_or(&provider).to_owned(), None, Vec::new()),
        (None, None) => return Err(failure(if provider.starts_with("custom:") { format!("The AI endpoint “{}” was removed. Choose another provider in Settings → AI Provider.", provider.trim_start_matches("custom:")) } else { format!("Unknown AI provider “{provider}”.") })),
    };
    let has_binding = ["profileId", "hostId", "agentId"].iter().any(|k| non_empty(&input, k).is_some());
    if !has_binding && ai.providers.get(&provider).and_then(|c| c.enabled) == Some(false) {
        return Err(failure(format!("{label} is turned off. Enable it under Settings → AI Provider.")));
    }
    if !has_binding && kind == DescriptorKind::Api {
        let has_key = host.secrets().has(&praxis_ai::providers::registry::secret_key_for_provider(&provider)) || (provider == "vercel-gateway" && praxis_ai::providers::registry::gateway_key_from_env().is_some());
        let needs_key = custom.as_ref().is_none_or(|c| c["auth"]["kind"] != "none");
        if !has_key && needs_key {
            return Err(failure(format!("No {label} API key configured. Add one under Settings → AI Provider.")));
        }
    }
    // An endpoint whose connection test showed no tool calling would fail on its first tool use.
    if !has_binding && let Some(c) = &custom && !c["capabilities"].is_null() && c["capabilities"]["tools"] != true {
        return Err(failure(format!("{label} didn't pass tool calling, which agent sessions need. Run its connection test in Settings → AI Provider after changing the model or server.")));
    }
    if has_binding {
        return Err(failure("Sessions bound to an agent profile or launch binding are not implemented yet."));
    }
    if input["runInWorktree"] == true {
        return Err(failure("Running a session in a dedicated worktree is not implemented yet."));
    }

    // The issue: a tracker issue, or a synthesized one for a free-form session.
    let issue = if let Some(issue_key) = non_empty(&input, "issueKey") {
        host_call(host, "issue:get", vec![json!(issue_key), input.get("connectionId").cloned().unwrap_or(Value::Null)])?
    } else {
        let goal = non_empty(&input, "goal").or_else(|| non_empty(&input["task"], "goal")).ok_or_else(|| failure("Delegate needs either an issue key or a goal."))?;
        json!({ "key": format!("SESSION-{}", &uuid::Uuid::new_v4().to_string()[..8]), "summary": goal, "issueType": "Task", "status": "New", "projectKey": "SESSION" })
    };
    if non_empty(&input, "issueKey").is_some() && ai.analysis_gate_enabled && input["mode"].is_null() && !is_analysis {
        // Mirrors the gate in Electron: confirmed analysis is required for legacy callers.
        let key = non_empty(&input, "issueKey").unwrap_or_default();
        let confirmed = host_call(host, "ai:getAnalysis", vec![json!(key)]).ok().is_some_and(|a| a["confirmed"] == true || a["state"] == "confirmed");
        if !confirmed {
            return Err(failure(format!("Analysis for {key} must be confirmed before delegating (the analysis gate is enabled in Settings → AI Provider).")));
        }
    }

    let task_overrides = input.get("task").filter(|t| t.is_object());
    let task = if !input["mode"].is_null() {
        build_mode_task(&mode, &issue, &analysis_prompt, task_overrides.unwrap_or(&Value::Null))
    } else if let Some(overrides) = task_overrides {
        default_task(&issue, overrides)
    } else {
        build_mode_task(&mode, &issue, &analysis_prompt, &Value::Null)
    };

    let existing_folder = non_empty(&input, "issueKey").and_then(|key| store(dir).get(key).ok().flatten()).and_then(|r| r["workingDirectory"].as_str().map(str::trim).filter(|w| !w.is_empty()).map(str::to_owned));
    let working_directory = non_empty(&input, "workingDirectory").map(str::to_owned)
        .or(existing_folder)
        .or_else(|| Some(ai.working_directory.trim().to_owned()).filter(|w| !w.is_empty()))
        .or_else(|| std::env::var("PRAXIS_AI_WORKING_DIR").ok().map(|w| w.trim().to_owned()).filter(|w| !w.is_empty()));

    let mut tool_mode = if is_analysis { Some("read-only".to_owned()) } else { non_empty(&input, "toolMode").map(str::to_owned) };
    // With no folder, a session that did not explicitly ask for tools converses with none.
    if working_directory.is_none() && (non_empty(&input, "toolMode").is_none() || mode == "chat") {
        tool_mode = Some("project-only".to_owned());
    }
    let tool_mode = tool_mode.unwrap_or_else(|| if working_directory.is_some() { "full".into() } else { "project-only".into() });
    if tool_mode == "full" && working_directory.is_none() {
        return Err(failure("Choose a working folder for this session — full-tools sessions no longer default to the app directory."));
    }

    let model_default = non_empty(&input, "model").map(str::to_owned).or_else(|| ai.providers.get(&provider).and_then(|c| c.default_model.clone()));
    let reasoning = non_empty(&input, "reasoningEffort").map(str::to_owned)
        .or_else(|| model_default.as_deref().and_then(|m| ai.providers.get(&provider)?.model_reasoning_defaults.as_ref()?.get(m).cloned()))
        .unwrap_or_else(|| "medium".into());
    let permission_mode = non_empty(&input, "permissionMode").unwrap_or("manual").to_owned();

    if kind == DescriptorKind::Api {
        let key = issue["key"].as_str().unwrap_or_default().to_owned();
        let selected_model = non_empty(&input, "model").map(str::to_owned);
        let default_model_hint = model_default.clone();
        drop(settings);
        let (connection, default_model) = super::ai_providers::api_connection(host, &provider)?;
        let model = selected_model.or(default_model_hint).unwrap_or(default_model);
        let images = sanitize_images(input.get("images").unwrap_or(&Value::Null));
        super::api_host::start_api_task(host, dir, super::api_host::ApiStart {
            issue, task, model, reasoning_effort: Some(reasoning), working_directory, tool_mode, auto_approve: matches!(permission_mode.as_str(), "bypass" | "autopilot"),
            permission_mode: Some(permission_mode), images, connection,
        })?;
        return finish_launch(dir, &key, &input);
    }
    let override_path = ai.providers.get(&provider).and_then(|c| c.cli_path.as_deref()).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned);
    let command = override_path.or(default_command).ok_or_else(|| failure("No command is configured for this provider."))?;
    let key = issue["key"].as_str().unwrap_or_default().to_owned();
    drop(settings);

    acp_host::start_task(host, dir, StartTask {
        issue, task, provider, model: non_empty(&input, "model").map(str::to_owned), reasoning_effort: Some(reasoning),
        working_directory, tool_mode, auto_approve: matches!(permission_mode.as_str(), "bypass" | "autopilot"), permission_mode: Some(permission_mode),
        command, args: default_args, mcp_servers: Vec::new(),
    })?;

    finish_launch(dir, &key, &input)
}

fn finish_launch(dir: &std::path::Path, key: &str, input: &Value) -> Result<Value> {
    let sessions = store(dir);
    for (field, name) in [("connectionId", "connectionId"), ("projectId", "projectId")] {
        if let Some(value) = non_empty(&input, field).map(str::to_owned) {
            let _ = sessions.mutate(key, true, |record| record[name] = json!(value));
        }
    }
    if let Some(parent) = non_empty(&input, "parentSessionKey").map(str::to_owned) {
        let _ = sessions.mutate(key, true, |record| record["parentSessionKey"] = json!(parent));
    }
    sessions.get(key)?.ok_or_else(|| failure(format!("Session for {key} did not start.")))
}

/// Normalises untrusted pasted images: base64 on a known image type, capped in count and size.
fn sanitize_images(images: &Value) -> Vec<Value> {
    const MAX_IMAGES: usize = 4;
    const MAX_BYTES: usize = 12 * 1024 * 1024;
    let mut out = Vec::new();
    let mut total = 0usize;
    for raw in images.as_array().into_iter().flatten() {
        if out.len() >= MAX_IMAGES {
            break;
        }
        let mime = raw["mimeType"].as_str().map(str::to_lowercase).unwrap_or_default();
        let data: String = raw["dataBase64"].as_str().map(|d| d.split_once(',').filter(|(head, _)| head.starts_with("data:")).map_or(d, |(_, rest)| rest)).unwrap_or_default().split_whitespace().collect();
        if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&mime.as_str()) || data.is_empty() || data.len() % 4 != 0 {
            continue;
        }
        total += data.len() * 3 / 4;
        if total > MAX_BYTES {
            break;
        }
        out.push(json!({ "mimeType": mime, "dataBase64": data }));
    }
    out
}

/// `ai:continueSession(issueKey, message, images?, options?)`.
fn continue_session(host: &HostContext, dir: &std::path::Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let record = store(dir).get(key)?.ok_or_else(|| failure(format!("No agent session found for {key}.")))?;
    if record["conversation"]["state"] == "running" {
        return Err(failure("Stop the multi-AI conversation before sending a single-agent follow-up."));
    }
    let provider = record["provider"].as_str().map(str::to_owned).unwrap_or_else(|| host.settings().read().ai.active_provider.clone());
    let descriptor = match built_in_descriptors().into_iter().find(|d| d.id == provider && d.kind == DescriptorKind::CliAgent) {
        Some(descriptor) => descriptor,
        None => {
            let (connection, _) = super::ai_providers::api_connection(host, &provider)?;
            super::api_host::continue_api_task(host, dir, key, text(args, 1)?, sanitize_images(args.get(2).unwrap_or(&Value::Null)), connection)?;
            return Ok(Value::Null);
        }
    };
    let override_path = host.settings().read().ai.providers.get(&provider).and_then(|c| c.cli_path.as_deref()).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned);
    let command = override_path.or(descriptor.default_command.clone()).ok_or_else(|| failure("No command is configured for this provider."))?;
    acp_host::continue_task(host, dir, key, Continue {
        message: text(args, 1)?.to_owned(),
        images: sanitize_images(args.get(2).unwrap_or(&Value::Null)),
        provider, command, args: descriptor.default_args, mcp_servers: Vec::new(),
        gadget_answer: args.get(3).is_some_and(|o| o["gadgetAnswer"] == true),
    })?;
    Ok(Value::Null)
}

pub fn dispatch(host: &HostContext, dir: &std::path::Path, channel: &str, args: &[Value]) -> Option<Result<Value>> {
    Some(match channel {
        "ai:delegate" => delegate(host, dir, args),
        "ai:continueSession" => continue_session(host, dir, args),
        "ai:abort" => (|| {
            let key = text(args, 0)?;
            acp_host::abort_task(host, dir, key);
            // Also settle a "ghost" session: left non-terminal by a crash with no task behind it.
            let sessions = store(dir);
            if let Some(record) = sessions.get(key)?
                && !acp_host::has_active_task(dir, key)
                && !acp_host::is_terminal(record["state"].as_str().unwrap_or_default())
            {
                if let Some(updated) = sessions.mutate(key, true, |r| r["state"] = json!("aborted"))? {
                    host.events().emit("ai:sessionChanged", Some(updated));
                }
            }
            Ok(Value::Null)
        })(),
        "ai:respondToPermission" => (|| {
            let decision = Decision::parse(text(args, 1)?).ok_or_else(|| failure("Unknown permission decision."))?;
            acp_host::respond_to_permission(dir, text(args, 0)?, decision);
            Ok(Value::Null)
        })(),
        "ai:setAcpMode" => acp_host::set_acp_mode(dir, text(args, 0).unwrap_or_default(), text(args, 1).unwrap_or_default()).map(|()| Value::Null),
        _ => return None,
    })
}
