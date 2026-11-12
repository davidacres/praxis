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

pub const CHANNELS: [&str; 6] = ["ai:delegate", "ai:abort", "ai:respondToPermission", "ai:setAcpMode", "ai:continueSession", "ai:resumeInterruptedSession"];

fn default_task(issue: &Value, overrides: &Value) -> Value {
    let summary = issue["summary"].as_str().unwrap_or_default();
    let description = issue["description"].as_str().filter(|d| !d.is_empty()).map(|d| format!("\n{}", d.chars().take(500).collect::<String>())).unwrap_or_default();
    let mut task = json!({
        "kind": "general",
        "goal": overrides["goal"].as_str().map_or_else(|| format!("{summary}{description}"), str::to_owned),
        "scope": overrides["scope"].as_str().unwrap_or("This issue and related files"),
        "definitionOfDone": overrides["definitionOfDone"].as_str().unwrap_or("All acceptance criteria met, code compiles, tests pass"),
    });
    for field in ["kind", "sessionMode"] {
        if let Some(value) = overrides[field].as_str() {
            task[field] = json!(value);
        }
    }
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

pub(super) fn delegate_channel(host: &HostContext, dir: &std::path::Path, args: &[Value]) -> Result<Value> {
    delegate(host, dir, args)
}

fn delegate(host: &HostContext, dir: &std::path::Path, args: &[Value]) -> Result<Value> {
    let mut input = args.first().cloned().unwrap_or(Value::Null);
    // A ticket review brings its own issue (keyed by the review session) and task contract.
    let review = input.get("ticketReview").filter(|r| r.is_object()).cloned();
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

    // The issue: a tracker issue, or a synthesized one for a free-form session.
    let issue = if let Some(review) = &review {
        review["issue"].clone()
    } else if let Some(issue_key) = non_empty(&input, "issueKey") {
        host_call(host, "issue:get", vec![json!(issue_key), input.get("connectionId").cloned().unwrap_or(Value::Null)])?
    } else if input["issue"].is_object() {
        // A caller-supplied stand-in (the Virtual Team assistant has no ticket of its own).
        input["issue"].clone()
    } else {
        let goal = non_empty(&input, "goal").or_else(|| non_empty(&input["task"], "goal")).ok_or_else(|| failure("Delegate needs either an issue key or a goal."))?;
        json!({ "key": format!("SESSION-{}", &uuid::Uuid::new_v4().to_string()[..8]), "summary": goal, "issueType": "Task", "status": "New", "projectKey": "SESSION" })
    };
    if review.is_none() && non_empty(&input, "issueKey").is_some() && ai.analysis_gate_enabled && input["mode"].is_null() && !is_analysis {
        // Mirrors the gate in Electron: confirmed analysis is required for legacy callers.
        let key = non_empty(&input, "issueKey").unwrap_or_default();
        let confirmed = host_call(host, "ai:getAnalysis", vec![json!(key)]).ok().is_some_and(|a| a["confirmed"] == true || a["state"] == "confirmed");
        if !confirmed {
            return Err(failure(format!("Analysis for {key} must be confirmed before delegating (the analysis gate is enabled in Settings → AI Provider).")));
        }
    }

    let task_overrides = input.get("task").filter(|t| t.is_object());
    let task = if let Some(review) = &review {
        review["task"].clone()
    } else if !input["mode"].is_null() {
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

    // Optionally run in a dedicated git worktree branched off the folder's current branch.
    let mut working_directory = working_directory;
    if input["runInWorktree"] == true {
        let folder = working_directory.clone().ok_or_else(|| failure("Pick a git repository folder to run this session in a worktree."))?;
        let prepared = super::ai_session_ops::prepare_worktree(&settings.delivery.default_base_branch, &issue, &folder, false, None)?;
        working_directory = Some(prepared["worktreePath"].as_str().unwrap_or_default().to_owned());
        input["__worktree"] = prepared;
    }

    let mut tool_mode = if is_analysis { Some("read-only".to_owned()) } else { non_empty(&input, "toolMode").map(str::to_owned) };
    // With no folder, a session that did not explicitly ask for tools converses with none.
    if working_directory.is_none() && (non_empty(&input, "toolMode").is_none() || mode == "chat") {
        tool_mode = Some("project-only".to_owned());
    }
    let tool_mode = tool_mode.unwrap_or_else(|| if working_directory.is_some() { "full".into() } else { "project-only".into() });
    // A review reads and never writes, whether or not it has a folder.
    let tool_mode = if review.is_some() { "read-only".to_owned() } else { tool_mode };
    if tool_mode == "full" && working_directory.is_none() {
        return Err(failure("Choose a working folder for this session — full-tools sessions no longer default to the app directory."));
    }

    let model_default = non_empty(&input, "model").map(str::to_owned).or_else(|| ai.providers.get(&provider).and_then(|c| c.default_model.clone()));
    let reasoning = non_empty(&input, "reasoningEffort").map(str::to_owned)
        .or_else(|| model_default.as_deref().and_then(|m| ai.providers.get(&provider)?.model_reasoning_defaults.as_ref()?.get(m).cloned()))
        .unwrap_or_else(|| "medium".into());
    let permission_mode = non_empty(&input, "permissionMode").unwrap_or("manual").to_owned();

    let override_path = ai.providers.get(&provider).and_then(|c| c.cli_path.as_deref()).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned);
    let provider_command = override_path.clone().or(default_command.clone());
    let skill_names: Vec<String> = input["skillNames"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    let (profile_id, host_id) = (non_empty(&input, "profileId").or_else(|| non_empty(&input, "agentId")).map(str::to_owned), non_empty(&input, "hostId").or_else(|| non_empty(&input, "agentId")).map(str::to_owned));
    let cli_providers = cli_commands(ai);
    drop(settings);
    let prepared = prepare_launch(host, dir, profile_id.as_deref(), host_id.as_deref(), &provider, kind, provider_command.as_deref(), &default_args, &skill_names)?;
    let mut task = task;
    if let Some(binding) = &prepared.binding {
        let goal = task["goal"].as_str().unwrap_or_default().to_owned();
        task["goal"] = json!(format!("{goal}\n\n{}", binding.context));
    }
    let is_autonomous = tool_mode == "full" && (matches!(permission_mode.as_str(), "bypass" | "autopilot") || task["kind"] == "implementation");
    apply_session_context(host, &mut task, &effective_runtime(&provider, kind, &prepared.plan, &cli_providers), working_directory.as_deref(), is_autonomous);
    let settings_key = issue["key"].as_str().unwrap_or_default().to_owned();

    if prepared.plan.state == "gateway" {
        let key = settings_key;
        let selected_model = non_empty(&input, "model").map(str::to_owned);
        let default_model_hint = model_default.clone();
        let (connection, default_model) = super::ai_providers::api_connection(host, &provider)?;
        let needs_key = custom.as_ref().is_none_or(|c| c["auth"]["kind"] != "none");
        if prepared.binding.is_some() && connection.options.api_key.as_deref().is_none_or(str::is_empty) && needs_key {
            return Err(failure(format!("No {label} API key configured for this session.")));
        }
        let model = selected_model.or(default_model_hint).unwrap_or(default_model);
        let images = sanitize_images(input.get("images").unwrap_or(&Value::Null));
        super::api_host::start_api_task(host, dir, super::api_host::ApiStart {
            issue, task, model, reasoning_effort: Some(reasoning), working_directory, tool_mode, auto_approve: matches!(permission_mode.as_str(), "bypass" | "autopilot"),
            permission_mode: Some(permission_mode), images, connection,
        })?;
        return finish_launch(dir, &key, &input, &prepared, &skill_names);
    }
    let key = settings_key;
    let command = prepared.plan.command.clone().ok_or_else(|| failure("No command is configured for this provider."))?;
    let args = prepared.plan.args.clone();
    // Praxis's own tracker and coordination tools come first, then the servers the user added.
    let mut mcp_servers: Vec<Value> = Vec::new();
    if prepared.plan.state == "acp" {
        if let Some(issue_key) = non_empty(&input, "issueKey") {
            mcp_servers.extend(super::builtin_mcp::tracker_server(host, dir, &key, non_empty(&input, "connectionId"), &tool_mode).filter(|_| !issue_key.is_empty()));
        }
        mcp_servers.extend(super::builtin_mcp::coordination_server(dir, &key, working_directory.as_deref(), &tool_mode));
        mcp_servers.extend(super::browser_mcp::server_for_session(host, dir, &key, &tool_mode));
    }
    mcp_servers.extend(super::user_mcp::acp_servers(host, &tool_mode, &provider));

    acp_host::start_task(host, dir, StartTask {
        issue, task, provider, model: non_empty(&input, "model").map(str::to_owned), reasoning_effort: Some(reasoning),
        working_directory, tool_mode, auto_approve: matches!(permission_mode.as_str(), "bypass" | "autopilot"), permission_mode: Some(permission_mode),
        command, args, mcp_servers,
    })?;

    finish_launch(dir, &key, &input, &prepared, &skill_names)
}

/// The adapter a session runs on, chosen before launch (`AgentHostLaunchPlan`).
pub(super) struct Plan {
    /// `acp` or `gateway`.
    pub state: &'static str,
    pub host_id: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
}

pub(super) struct Prepared {
    pub plan: Plan,
    pub binding: Option<super::agent_runtime::Binding>,
}

fn is_bundled_host(host_id: &str) -> bool {
    host_id.starts_with("praxis-") || host_id == "csharp-dotnet-code-reviewer"
}

/// A manifest `entry` as a command: bare executable names stay, files relative to the host's own
/// folder are resolved against it (never the app cwd).
fn entry_command(entry: &Value, root_path: &str) -> Result<(String, Vec<String>)> {
    let raw = entry.as_str().or_else(|| entry["command"].as_str()).map(str::trim).filter(|c| !c.is_empty()).ok_or_else(|| failure("The selected agent host does not declare an executable entry point."))?;
    let root = std::path::Path::new(root_path);
    let path_like = std::path::Path::new(raw).is_absolute() || raw.contains('/') || raw.contains('\\') || raw.ends_with(".js");
    let command = if path_like { praxis_core::agent_runtime::resolve_against(root, raw) } else { raw.to_owned() };
    let args = entry["args"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|arg| {
        let path_like = std::path::Path::new(arg).is_absolute() || arg.starts_with("./") || arg.starts_with(".\\") || arg.ends_with(".js");
        if path_like && !std::path::Path::new(arg).is_absolute() { praxis_core::agent_runtime::resolve_against(root, arg) } else { arg.to_owned() }
    }).collect();
    Ok((command, args))
}

fn is_scaffold_host(root_path: &str) -> bool {
    std::fs::read_to_string(std::path::Path::new(root_path).join("index.js")).is_ok_and(|entry| entry.contains("SCAFFOLD") && entry.contains("scaffold not implemented"))
}

/// Compiles a discovered manifest into an explicit, supported session adapter.
fn compile_host_launch(definition: &Value, kind: DescriptorKind, provider_label: &str, provider_command: Option<&str>, provider_args: &[String]) -> Result<Plan> {
    let manifest = &definition["manifest"];
    let id = manifest["id"].as_str().unwrap_or_default().to_owned();
    // Built-in agents, agents found in other AI tools' folders and copies of them
    // (`entry: "session"`) all run on the session's own runtime.
    if is_bundled_host(&id) || definition["followsSessionRuntime"] == true || manifest["entry"] == "session" {
        if kind == DescriptorKind::Api {
            return Ok(Plan { state: "gateway", host_id: Some(id), command: None, args: Vec::new() });
        }
        let command = provider_command.ok_or_else(|| failure("No command is configured for this provider."))?.to_owned();
        return Ok(Plan { state: "acp", host_id: Some(id), command: Some(command), args: provider_args.to_vec() });
    }
    match manifest["type"].as_str().unwrap_or_default() {
        "acp" => {
            let root = definition["rootPath"].as_str().unwrap_or_default();
            if is_scaffold_host(root) {
                return Err(failure(format!("Agent host \"{id}\" is a scaffold and has no working protocol adapter.")));
            }
            let (command, args) = entry_command(&manifest["entry"], root)?;
            Ok(Plan { state: "acp", host_id: Some(id), command: Some(command), args })
        }
        // A gateway manifest opts into the provider-backed transport and must name an API provider.
        "gateway" => {
            if kind != DescriptorKind::Api {
                return Err(failure(format!("Gateway host \"{id}\" requires an API provider; \"{provider_label}\" is CLI-hosted.")));
            }
            Ok(Plan { state: "gateway", host_id: Some(id), command: None, args: Vec::new() })
        }
        other => Err(failure(format!("Agent host \"{id}\" declares unsupported transport \"{other}\"."))),
    }
}

/// Resolves and validates one Agent Hub binding immediately before launch.
#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_launch(
    host: &HostContext,
    dir: &std::path::Path,
    profile_id: Option<&str>,
    host_id: Option<&str>,
    provider: &str,
    kind: DescriptorKind,
    provider_command: Option<&str>,
    provider_args: &[String],
    skill_names: &[String],
) -> Result<Prepared> {
    if profile_id.is_some() != host_id.is_some() {
        return Err(failure("A session binding requires both an agent profile and runtime host."));
    }
    let (Some(profile_id), Some(host_id)) = (profile_id, host_id) else {
        let plan = if kind == DescriptorKind::CliAgent {
            let command = provider_command.ok_or_else(|| failure("No command is configured for this provider."))?.to_owned();
            Plan { state: "acp", host_id: None, command: Some(command), args: provider_args.to_vec() }
        } else {
            Plan { state: "gateway", host_id: None, command: None, args: Vec::new() }
        };
        return Ok(Prepared { plan, binding: None });
    };
    let binding = super::agent_runtime::create_binding(host, dir, profile_id, host_id, provider, skill_names)?;
    let label = built_in_descriptors().into_iter().find(|d| d.id == provider).map_or_else(|| provider.to_owned(), |d| d.label);
    let plan = compile_host_launch(&binding.host, kind, &label, provider_command, provider_args)?;
    Ok(Prepared { plan, binding: Some(binding) })
}

/// The `[provider id -> configured command]` of every CLI runtime.
fn cli_commands(ai: &praxis_core::config::app_settings::AiSettings) -> Vec<(String, String)> {
    built_in_descriptors()
        .into_iter()
        .filter(|d| d.kind == DescriptorKind::CliAgent)
        .filter_map(|d| {
            let configured = ai.providers.get(&d.id).and_then(|c| c.cli_path.as_deref()).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned);
            configured.or(d.default_command.clone()).map(|command| (d.id, command))
        })
        .collect()
}

/// Which runtime really runs a launch: an API provider reads no tool files; a built-in CLI runtime
/// reads its own; a custom ACP binding reads none of the files Praxis knows about (`custom`).
fn effective_runtime(provider: &str, kind: DescriptorKind, plan: &Plan, clis: &[(String, String)]) -> String {
    if plan.state != "acp" {
        return provider.to_owned();
    }
    let configured = clis.iter().find(|(id, _)| id == provider).map(|(_, command)| command.as_str());
    if kind == DescriptorKind::CliAgent && plan.command.as_deref().is_none_or(|command| Some(command) == configured) {
        return provider.to_owned();
    }
    let base = |command: &str| std::path::Path::new(command).file_name().map(|n| n.to_string_lossy().into_owned());
    // A custom ACP binding that launches one of the known runtimes reads what it reads.
    plan.command.as_deref().and_then(base).and_then(|launched| clis.iter().find(|(_, command)| base(command).as_deref() == Some(launched.as_str())).map(|(id, _)| id.clone())).unwrap_or_else(|| "custom".to_owned())
}

/// The working style every session carries, whichever AI runs it (Settings > Agent Runtime).
fn session_working_style(host: &HostContext, autonomous: bool) -> Option<String> {
    let style = host.settings().read().ai.working_style.clone();
    if !style.enabled {
        return None;
    }
    let raw = if style.text.trim().is_empty() { praxis_core::config::app_settings::DEFAULT_WORKING_STYLE.to_owned() } else { style.text.trim().to_owned() };
    if !autonomous {
        return Some(raw);
    }
    let undo = regex::Regex::new(r"- Before anything that is hard to undo[^\n]*\n?").expect("static pattern");
    let plan = regex::Regex::new(r"- Before a multi-step change, state a short plan[^\n]*\n?").expect("static pattern");
    let raw = undo.replace_all(&raw, "- You have full autonomous execution authority in this isolated worktree. Proceed directly with all necessary edits, test executions, and commits without pausing to request approval.\n");
    let raw = plan.replace_all(&raw, "- Proceed directly to implement all planned changes, run verification tests, and commit cleanly to git.\n");
    Some(raw.trim().to_owned())
}

/// The project instructions (minus what the runtime reads itself) and working style a session carries.
fn apply_session_context(host: &HostContext, task: &mut Value, runtime: &str, working_directory: Option<&str>, autonomous: bool) {
    if let Some(instructions) = super::agent_runtime::session_instructions(host, runtime, working_directory) {
        task["projectInstructions"] = json!(instructions);
    }
    if let Some(style) = session_working_style(host, autonomous) {
        task["workingStyle"] = json!(style);
    }
}

/// Records which adapter ran the session (`AgentRuntimeLaunch`).
fn runtime_launch(prepared: &Prepared) -> Value {
    let transport = prepared.plan.state;
    let adapter = if prepared.binding.is_some() { transport.to_owned() } else { format!("legacy-{transport}") };
    let mut launch = json!({ "adapter": adapter, "transport": transport });
    if let Some(host_id) = &prepared.plan.host_id {
        launch["hostId"] = json!(host_id);
    }
    if let Some(command) = &prepared.plan.command {
        launch["command"] = json!(command);
    }
    launch
}

fn finish_launch(dir: &std::path::Path, key: &str, input: &Value, prepared: &Prepared, skill_names: &[String]) -> Result<Value> {
    let sessions = store(dir);
    let launch = runtime_launch(prepared);
    let _ = sessions.mutate(key, true, |record| record["runtimeLaunch"] = launch);
    if input["__worktree"].is_object() {
        let worktree = input["__worktree"].clone();
        let _ = sessions.mutate(key, true, |record| {
            record["workingDirectory"] = worktree["worktreePath"].clone();
            record["worktreePath"] = worktree["worktreePath"].clone();
            record["worktreeBranch"] = worktree["branchName"].clone();
            record["worktreeBaseBranch"] = worktree["baseBranch"].clone();
            record["worktreeName"] = worktree["worktreeName"].clone();
        });
    }
    if let (Some(binding), Some(host_id)) = (&prepared.binding, prepared.plan.host_id.as_deref()) {
        let profile_id = non_empty(input, "profileId").or_else(|| non_empty(input, "agentId")).unwrap_or_default().to_owned();
        let (host_id, activations) = (host_id.to_owned(), binding.skill_activations.clone());
        let skills = skill_names.to_vec();
        let _ = sessions.mutate(key, true, |record| {
            record["agentId"] = json!(host_id);
            record["profileId"] = json!(profile_id);
            record["hostId"] = json!(host_id);
            if !skills.is_empty() {
                record["activeSkills"] = json!(skills);
            }
            if !activations.is_empty() {
                record["skillActivations"] = json!(activations);
            }
        });
    }
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
pub(super) fn sanitize_images(images: &Value) -> Vec<Value> {
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
    if store(dir).get(text(args, 0)?)?.is_some_and(|record| record["conversation"]["state"] == "running") {
        return Err(failure("Stop the multi-AI conversation before sending a single-agent follow-up."));
    }
    continue_with(host, dir, args, false, None)
}

/// Continues a recorded session. `internal` marks a turn Praxis schedules between the AIs of a
/// multi-AI conversation; `conversation_context` is the system context that turn adds.
pub(super) fn continue_with(host: &HostContext, dir: &std::path::Path, args: &[Value], internal: bool, conversation_context: Option<&str>) -> Result<Value> {
    let key = text(args, 0)?;
    let record = store(dir).get(key)?.ok_or_else(|| failure(format!("No agent session found for {key}.")))?;
    let provider = record["provider"].as_str().map(str::to_owned).unwrap_or_else(|| host.settings().read().ai.active_provider.clone());
    let cli = built_in_descriptors().into_iter().find(|d| d.id == provider && d.kind == DescriptorKind::CliAgent);
    let kind = if cli.is_some() { DescriptorKind::CliAgent } else { DescriptorKind::Api };
    let override_path = host.settings().read().ai.providers.get(&provider).and_then(|c| c.cli_path.as_deref()).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned);
    let provider_command = override_path.or(cli.as_ref().and_then(|d| d.default_command.clone()));
    let provider_args = cli.as_ref().map(|d| d.default_args.clone()).unwrap_or_default();
    // A bound session continues through the same compiled adapter as its first turn.
    let skills: Vec<String> = record["activeSkills"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    let (profile_id, host_id) = (non_empty(&record, "profileId"), non_empty(&record, "hostId"));
    let prepared = prepare_launch(host, dir, profile_id, host_id, &provider, kind, provider_command.as_deref(), &provider_args, &skills)?;
    // Recomputed each turn: a handover can move the session to a runtime that reads different files.
    let mut task = record["taskDefinition"].clone();
    if task.is_object() {
        for field in ["projectInstructions", "workingStyle"] {
            task.as_object_mut().map(|object| object.remove(field));
        }
        let autonomous = record["autoApprovePermissions"] == true || record["permissionMode"] == "autopilot" || task["kind"] == "implementation";
        let runtime = effective_runtime(&provider, kind, &prepared.plan, &cli_commands(&host.settings().read().ai));
        apply_session_context(host, &mut task, &runtime, record["workingDirectory"].as_str(), autonomous);
        let _ = store(dir).mutate(key, true, |stored| stored["taskDefinition"] = task);
    }
    if prepared.plan.state == "gateway" {
        let (connection, _) = super::ai_providers::api_connection(host, &provider)?;
        let custom_without_auth = host.settings().read().ai.custom_providers.iter().flatten().any(|c| c.id == provider && serde_json::to_value(c).is_ok_and(|v| v["auth"]["kind"] == "none"));
        if connection.options.api_key.as_deref().is_none_or(str::is_empty) && !custom_without_auth {
            return Err(failure(format!("No {} API key configured for this session.", connection.label)));
        }
        super::api_host::continue_api_task(host, dir, key, text(args, 1)?, sanitize_images(args.get(2).unwrap_or(&Value::Null)), connection, internal, conversation_context)?;
        let launch = runtime_launch(&prepared);
        let _ = store(dir).mutate(key, true, |stored| stored["runtimeLaunch"] = launch);
        return Ok(Value::Null);
    }
    let command = prepared.plan.command.clone().ok_or_else(|| failure("No command is configured for this provider."))?;
    let tool_mode = record["toolMode"].as_str().unwrap_or("full").to_owned();
    let mut mcp_servers: Vec<Value> = Vec::new();
    // A free-form session has no tracker issue behind it.
    if !key.starts_with("SESSION-") {
        mcp_servers.extend(super::builtin_mcp::tracker_server(host, dir, key, non_empty(&record, "connectionId"), &tool_mode));
    }
    mcp_servers.extend(super::builtin_mcp::coordination_server(dir, key, record["workingDirectory"].as_str(), &tool_mode));
    mcp_servers.extend(super::browser_mcp::server_for_session(host, dir, key, &tool_mode));
    mcp_servers.extend(super::user_mcp::acp_servers(host, &tool_mode, &provider));
    acp_host::continue_task(host, dir, key, Continue {
        message: text(args, 1)?.to_owned(),
        images: sanitize_images(args.get(2).unwrap_or(&Value::Null)),
        provider, command, args: prepared.plan.args.clone(), mcp_servers,
        gadget_answer: args.get(3).is_some_and(|o| o["gadgetAnswer"] == true),
        internal, conversation_context: conversation_context.map(str::to_owned),
    })?;
    let launch = runtime_launch(&prepared);
    let _ = store(dir).mutate(key, true, |stored| stored["runtimeLaunch"] = launch);
    Ok(Value::Null)
}

fn recovering() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static SET: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
    SET.get_or_init(Default::default)
}

/// `ai:resumeInterruptedSession(issueKey)`: continues a session the app restart stopped.
fn resume_interrupted(host: &HostContext, dir: &std::path::Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let record = store(dir).get(key)?;
    let awaiting = record.as_ref().is_some_and(|r| r["interruptedByRestart"] == true && r["archived"] != true && r["workflowNodeId"].is_null() && matches!(r["state"].as_str(), Some("aborted" | "paused")));
    let gate = format!("{}\u{0}{key}", dir.display());
    if !awaiting || acp_host::has_active_task(dir, key) || !recovering().lock().map_or(false, |mut set| set.insert(gate.clone())) {
        return Err(failure("This session is no longer awaiting startup recovery."));
    }
    let outcome = (|| {
        let record = record.unwrap_or(Value::Null);
        let provider = record["provider"].as_str().unwrap_or_default().to_owned();
        // A restarted conversation recovers as a single-agent turn.
        if record["conversation"]["state"] == "running" {
            let _ = store(dir).mutate(key, true, |r| r["conversation"]["state"] = json!("stopped"));
        }
        continue_session(host, dir, &[json!(key), json!("Resume the task interrupted by the app restart. Review the existing conversation and current state before continuing.")])?;
        let _ = store(dir).mutate(key, true, |r| {
            r.as_object_mut().map(|o| o.remove("interruptedByRestart"));
        });
        super::log_bus::log(host, &format!("[ai] Resuming interrupted session provider={provider} session={key} at={}", super::now()));
        Ok(Value::Null)
    })();
    if let Ok(mut set) = recovering().lock() {
        set.remove(&gate);
    }
    outcome
}

pub fn dispatch(host: &HostContext, dir: &std::path::Path, channel: &str, args: &[Value]) -> Option<Result<Value>> {
    Some(match channel {
        "ai:delegate" => delegate(host, dir, args),
        "ai:continueSession" => continue_session(host, dir, args),
        "ai:resumeInterruptedSession" => resume_interrupted(host, dir, args),
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
