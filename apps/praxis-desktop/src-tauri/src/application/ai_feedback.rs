//! Prompt and session feedback (`ai:evaluatePrompt`, `ai:evaluateSession`, the finding reviews and
//! the stored scorecards). The scoring itself is `praxis_ai::feedback`; this host half gathers the
//! session, the workspace facts and the model's read of the prompt, and persists the results.
//! Ports the feedback handlers of Electron's `aiIpc.ts`, `findingFeedbackIpc.ts`,
//! `feedbackWorkspaceHints.ts` and `promptClarityReader.ts`.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use praxis_ai::feedback::clarity::{self, Answers};
use praxis_ai::feedback::diagnostics::{self, Stage};
use praxis_ai::feedback::grounding::derive_prior_context;
use praxis_ai::feedback::store as feedback_store;
use praxis_ai::feedback::{
    CLARITY_CHECKLIST_VERSION, EvaluationInput, PriorContext, SCORING_RUBRIC_VERSION,
    WorkspaceHints, evaluate,
};
use praxis_host::HostContext;
use serde_json::{Value, json};

use super::api_host::ApiConnection;
use super::storage::{encoded, parse, read, write_atomic};
use super::{Result, failure, now, text};

pub const CHANNELS: [&str; 7] = [
    "ai:evaluatePrompt",
    "ai:getFindingFeedback",
    "ai:reviewFinding",
    "ai:evaluateSession",
    "ai:getSessionFeedback",
    "ai:submitSessionFeedback",
    "ai:rewritePromptFromFeedback",
];

const CACHE_TTL: Duration = Duration::from_secs(15);
const MAX_TRACKED_FILES: usize = 20_000;
const MAX_CACHED_ANSWERS: usize = 2000;
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_IN_FLIGHT: usize = 2;

fn feedback_file(dir: &Path) -> PathBuf {
    dir.join("session-feedback.json")
}

fn cache_file(dir: &Path) -> PathBuf {
    dir.join("prompt-clarity-cache.json")
}

// ── the persisted store ──────────────────────────────────────────────────────────────────────

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Mutex::default)
}

fn load_state(dir: &Path) -> Value {
    let path = feedback_file(dir);
    let document = read(&path)
        .ok()
        .flatten()
        .and_then(|raw| parse(&path, Some(&raw)).ok());
    feedback_store::normalize(document.as_ref().map(|d| &d[feedback_store::STORAGE_KEY]))
}

/// Reads the store, applies `change`, and writes it back when `change` succeeds.
fn with_store<R>(
    dir: &Path,
    change: impl FnOnce(&mut Value) -> std::result::Result<R, String>,
) -> Result<R> {
    let _guard = store_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut state = load_state(dir);
    let outcome = change(&mut state).map_err(failure)?;
    write_atomic(
        &feedback_file(dir),
        &encoded(&json!({ feedback_store::STORAGE_KEY: state }))?,
        false,
    )?;
    Ok(outcome)
}

fn read_store(dir: &Path) -> Value {
    let _guard = store_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    load_state(dir)
}

/// Reports this host evaluated, so a label binds to a real assessment rather than a renderer's claim.
fn recent_reports() -> &'static Mutex<(HashMap<String, Value>, VecDeque<String>)> {
    #[allow(clippy::type_complexity)]
    static RECENT: OnceLock<Mutex<(HashMap<String, Value>, VecDeque<String>)>> = OnceLock::new();
    RECENT.get_or_init(Mutex::default)
}

fn remember(report: Value) -> Value {
    let digest = report["inputDigest"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let mut recent = recent_reports()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if recent.0.insert(digest.clone(), report.clone()).is_none() {
        recent.1.push_back(digest);
    }
    while recent.1.len() > 128 {
        if let Some(oldest) = recent.1.pop_front() {
            recent.0.remove(&oldest);
        }
    }
    report
}

// ── workspace facts ──────────────────────────────────────────────────────────────────────────

fn git(cwd: &Path, args: &[&str]) -> String {
    let Ok(mut child) = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return String::new();
    };
    let Some(mut stdout) = child.stdout.take() else {
        return String::new();
    };
    let reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buffer);
        buffer
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned()
                } else {
                    String::new()
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return String::new();
            }
        }
    }
}

/// `git status --porcelain` paths relative to `cwd` (renames keep the new path).
fn parse_status(output: &str, repo_root: &Path, cwd: &Path) -> Vec<String> {
    output
        .lines()
        .filter(|line| line.len() >= 4)
        .filter_map(|line| {
            let raw = line[3..]
                .rsplit(" -> ")
                .next()
                .unwrap_or_default()
                .trim_matches('"');
            if Path::new(raw)
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return None;
            }
            let relative = repo_root
                .join(raw)
                .strip_prefix(cwd)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            Some(relative)
        })
        .collect()
}

fn gather_hints(folder: &str) -> Option<WorkspaceHints> {
    let cwd = std::fs::canonicalize(folder).unwrap_or_else(|_| PathBuf::from(folder));
    let repo_root = git(&cwd, &["rev-parse", "--show-toplevel"])
        .trim()
        .to_owned();
    let (changed_files, tracked_files) = if repo_root.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let status = git(&cwd, &["status", "--porcelain", "--untracked-files=all"]);
        let tracked = git(&cwd, &["ls-files"]);
        (
            parse_status(&status, Path::new(&repo_root), &cwd),
            tracked
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .take(MAX_TRACKED_FILES)
                .map(str::to_owned)
                .collect::<Vec<_>>(),
        )
    };
    let package_scripts: Vec<String> = std::fs::read_to_string(cwd.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|manifest| {
            manifest["scripts"]
                .as_object()
                .map(|scripts| scripts.keys().cloned().collect())
        })
        .unwrap_or_default();
    let is_test = |file: &&String| {
        file.rsplit_once('.').is_some_and(|(stem, ext)| {
            matches!(ext, "ts" | "tsx") && (stem.ends_with(".spec") || stem.ends_with(".test"))
        })
    };
    let test_files = tracked_files.iter().filter(is_test).cloned().collect();
    if changed_files.is_empty() && tracked_files.is_empty() && package_scripts.is_empty() {
        return None;
    }
    Some(WorkspaceHints {
        changed_files,
        test_files,
        package_scripts,
        tracked_files,
        symbols: Vec::new(),
    })
}

/// Raw workspace facts for a folder, cached briefly because the composer asks on every typing pause.
fn workspace_hints(folder: Option<&str>, _prompt: &str) -> Option<WorkspaceHints> {
    #[allow(clippy::type_complexity)]
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Option<WorkspaceHints>)>>> =
        OnceLock::new();
    let folder = folder.map(str::trim).filter(|f| !f.is_empty())?;
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some((at, hints)) = cache.lock().ok()?.get(folder)
        && at.elapsed() < CACHE_TTL
    {
        return hints.clone();
    }
    let hints = gather_hints(folder);
    if let Ok(mut cache) = cache.lock() {
        cache.insert(folder.to_owned(), (Instant::now(), hints.clone()));
    }
    hints
}

/// Whether the folder's code intelligence is switched on (project override, else the global flag).
fn code_intelligence_enabled(host: &HostContext, folder: Option<&str>) -> bool {
    let settings = host.settings().read();
    let Some(config) = settings.ai.code_intelligence.as_ref() else {
        return true;
    };
    let overridden = folder.and_then(|f| {
        config
            .project_overrides
            .as_ref()
            .and_then(|o| o.get(f).or_else(|| o.get(f.trim_end_matches('/'))))
    });
    overridden.copied().unwrap_or(config.enabled)
}

// ── catalog ──────────────────────────────────────────────────────────────────────────────────

struct Catalog {
    skills: Vec<Value>,
    agents: Vec<Value>,
    mcp_servers: Vec<String>,
}

fn catalog(host: &HostContext, dir: &Path) -> Catalog {
    let snapshot = super::agent_runtime::list(host, dir);
    let skills = snapshot["skills"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| json!({ "name": s["metadata"]["name"], "title": s["metadata"]["title"], "description": s["metadata"]["description"], "triggers": s["metadata"]["triggers"].as_array().cloned().unwrap_or_default() }))
        .collect();
    let agents = snapshot["profiles"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| json!({ "id": e["profile"]["id"], "name": e["profile"]["name"], "description": e["profile"]["description"], "preferredSkills": e["profile"]["preferredSkills"].as_array().cloned().unwrap_or_default() }))
        .collect();
    let mcp_servers = host
        .settings()
        .read()
        .ai
        .mcp_servers
        .iter()
        .flatten()
        .filter(|s| s.enabled)
        .map(|s| s.name.clone())
        .collect();
    Catalog {
        skills,
        agents,
        mcp_servers,
    }
}

// ── the model's read of a prompt ─────────────────────────────────────────────────────────────

/// How the prompt check reaches its model: a direct API completion, or a one-shot prompt to a CLI
/// agent over ACP (a CLI-only setup has no API key to complete against).
enum Source {
    Api(ApiConnection),
    Cli { command: String, args: Vec<String> },
}

struct Choice {
    source: Source,
    provider: String,
    /// The model sent to the provider; empty for a CLI agent left on its own default.
    model: String,
}

impl Choice {
    /// The model as shown and cached: `provider/model`, `cli-default` for an unpinned CLI agent.
    fn label(&self) -> String {
        let model = if self.model.is_empty() {
            "cli-default"
        } else {
            &self.model
        };
        format!("{}/{model}", self.provider)
    }

    fn endpoint(&self) -> &str {
        match &self.source {
            Source::Api(connection) => Some(connection.options.url.as_str())
                .filter(|u| !u.is_empty())
                .unwrap_or("default-endpoint"),
            Source::Cli { .. } => "default-endpoint",
        }
    }
}

/// The CLI agents that can read a prompt, in the order a CLI-only setup tries them.
const CLI_CANDIDATES: [&str; 5] = [
    "claude-code-cli",
    "codex-cli",
    "copilot-cli",
    "antigravity-cli",
    "cursor-cli",
];

/// A CLI provider that is switched on and whose executable can be found.
fn cli_choice(host: &HostContext, provider: &str, model: Option<&str>) -> Option<Choice> {
    use praxis_ai::providers::environment::effective_path;
    use praxis_ai::providers::registry::{
        DescriptorKind, built_in_descriptors, resolve_executable,
    };
    let descriptor = built_in_descriptors()
        .into_iter()
        .find(|d| d.id == provider && d.kind == DescriptorKind::CliAgent)?;
    let settings = host.settings().read();
    let config = settings.ai.providers.get(provider);
    if config.and_then(|c| c.enabled) == Some(false) {
        return None;
    }
    let command = config
        .and_then(|c| c.cli_path.as_deref())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .or(descriptor.default_command.clone())?;
    drop(settings);
    resolve_executable(&command, effective_path())?;
    Some(Choice {
        source: Source::Cli {
            command,
            args: descriptor.default_args.clone(),
        },
        provider: provider.to_owned(),
        model: model.unwrap_or_default().to_owned(),
    })
}

fn ready(host: &HostContext, provider: &str) -> Option<(ApiConnection, String)> {
    super::ai_providers::api_connection(host, provider)
        .ok()
        .filter(|(connection, _)| {
            connection
                .options
                .api_key
                .as_deref()
                .is_some_and(|k| !k.trim().is_empty())
        })
}

/// The provider that reads prompts: the prompt-analysis provider, else the recommendation provider,
/// else the active provider when it has a key, else the first API provider that does, else (a
/// CLI-only setup) the active or first installed CLI agent.
fn prompt_check_choice(host: &HostContext) -> Option<Choice> {
    use praxis_ai::providers::registry::{DescriptorKind, built_in_descriptors};
    let (explicit, recommendation, active, model_override, custom) = {
        let settings = host.settings().read();
        let ai = &settings.ai;
        (
            ai.prompt_analysis_provider
                .clone()
                .filter(|p| !p.is_empty()),
            ai.recommendation_provider.clone().filter(|p| !p.is_empty()),
            ai.active_provider.clone(),
            ai.prompt_analysis_model
                .clone()
                .map(|m| m.trim().to_owned())
                .filter(|m| !m.is_empty()),
            ai.custom_providers
                .iter()
                .flatten()
                .filter_map(|c| {
                    serde_json::to_value(c).ok()?["id"]
                        .as_str()
                        .map(str::to_owned)
                })
                .collect::<Vec<_>>(),
        )
    };
    let (provider, (connection, default_model)) =
        if let Some(provider) = explicit.or(recommendation) {
            if let Some(cli) = cli_choice(host, &provider, model_override.as_deref()) {
                return Some(cli);
            }
            let pair = ready(host, &provider)?;
            (provider, pair)
        } else {
            let active_provider = active.clone();
            let mut order = vec![active];
            order.extend(
                built_in_descriptors()
                    .into_iter()
                    .filter(|d| d.kind == DescriptorKind::Api)
                    .map(|d| d.id),
            );
            order.extend(custom);
            let mut seen = Vec::new();
            let found = order
                .into_iter()
                .filter(|p| {
                    !seen.contains(p) && {
                        seen.push(p.clone());
                        true
                    }
                })
                .find_map(|p| ready(host, &p).map(|pair| (p, pair)));
            match found {
                Some(found) => found,
                // No API key anywhere: a CLI agent that is installed can still read the prompt.
                None => {
                    return std::iter::once(active_provider.as_str())
                        .chain(CLI_CANDIDATES)
                        .find_map(|p| cli_choice(host, p, model_override.as_deref()));
                }
            }
        };
    Some(Choice {
        source: Source::Api(connection),
        provider,
        model: model_override.unwrap_or(default_model),
    })
}

fn in_flight() -> &'static Mutex<Vec<String>> {
    static FLIGHT: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    FLIGHT.get_or_init(Mutex::default)
}

fn assessment(status: &str, model: Option<&str>, extra: Value) -> Value {
    let mut result = json!({ "status": status, "checklistVersion": CLARITY_CHECKLIST_VERSION });
    if let Some(model) = model {
        result["model"] = json!(model);
    }
    if let (Some(target), Some(extra)) = (result.as_object_mut(), extra.as_object()) {
        target.extend(extra.clone());
    }
    result
}

fn cached_answers(dir: &Path) -> Value {
    let path = cache_file(dir);
    read(&path)
        .ok()
        .flatten()
        .and_then(|raw| parse(&path, Some(&raw)).ok())
        .map(|d| d["answers"].clone())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn remember_answers(dir: &Path, key: &str, model: &str, answers: &Answers) -> Result<()> {
    let _guard = store_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut cached = cached_answers(dir);
    cached[key] =
        json!({ "model": model, "answers": answers, "at": chrono::Utc::now().timestamp_millis() });
    if let Some(entries) = cached.as_object_mut()
        && entries.len() > MAX_CACHED_ANSWERS
    {
        let mut by_age: Vec<(String, i64)> = entries
            .iter()
            .map(|(k, v)| (k.clone(), v["at"].as_i64().unwrap_or(0)))
            .collect();
        by_age.sort_by_key(|(_, at)| *at);
        for (stale, _) in by_age.into_iter().take(entries.len() - MAX_CACHED_ANSWERS) {
            entries.remove(&stale);
        }
    }
    write_atomic(
        &cache_file(dir),
        &encoded(&json!({ "answers": cached }))?,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn log_line(
    host: &HostContext,
    check_id: &str,
    model: &str,
    stage: Stage,
    started: Instant,
    prompt_chars: usize,
    reply_chars: usize,
    event: &str,
    extra: Value,
) {
    let mut line = json!({
        "event": event, "checkId": check_id, "model": model, "stage": stage.name(), "elapsedMs": started.elapsed().as_millis() as u64,
        "promptChars": prompt_chars, "replyChars": reply_chars,
    });
    if let (Some(target), Some(extra)) = (line.as_object_mut(), extra.as_object()) {
        target.extend(extra.clone());
    }
    super::log_bus::log(host, &format!("[prompt-analysis] {line}"));
}

/// Reads a prompt against the clarity checklist. Retained answers are reused (also across restarts);
/// `call: false` never waits on a model and answers `pending` when nothing is retained.
fn assess_prompt(
    host: &HostContext,
    dir: &Path,
    prompt: &str,
    prior: Option<&PriorContext>,
    call: bool,
) -> Value {
    let text = prompt.trim();
    if text.is_empty() {
        return assessment("unavailable", None, json!({ "reason": "Empty prompt." }));
    }
    let Some(choice) = prompt_check_choice(host) else {
        return assessment(
            "unavailable",
            None,
            json!({ "reason": "No AI provider is configured to read prompts." }),
        );
    };
    let model = choice.label();
    let key = clarity::cache_key(text, prior, &format!("{model}@{}", choice.endpoint()));
    let lookup = || -> Option<Value> {
        let hit = cached_answers(dir)[&key].clone();
        let answers = clarity::parse_answers(&hit["answers"].to_string(), text, prior).ok()?;
        Some(assessment(
            "checked",
            hit["model"].as_str(),
            json!({ "cached": true, "answers": answers }),
        ))
    };
    if let Some(found) = lookup() {
        return found;
    }
    if !call {
        return assessment("pending", Some(&model), json!({}));
    }
    // Bound simultaneous background work; an identical check already running is waited for.
    loop {
        let mut flight = in_flight()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if flight.contains(&key) {
            drop(flight);
            std::thread::sleep(Duration::from_millis(50));
            if let Some(found) = lookup() {
                return found;
            }
            continue;
        }
        if flight.len() >= MAX_IN_FLIGHT {
            return assessment(
                "unavailable",
                Some(&model),
                json!({ "reason": "Other prompt checks are still running. Edit the draft to retry." }),
            );
        }
        flight.push(key.clone());
        break;
    }
    let check_id = uuid::Uuid::new_v4().to_string();
    let started = Instant::now();
    let mut stage = Stage::ProviderRequest;
    let mut reply_chars = 0;
    let prompt_chars = text.chars().count();
    log_line(
        host,
        &check_id,
        &model,
        stage,
        started,
        prompt_chars,
        0,
        "started",
        json!({}),
    );
    let outcome = (|| -> std::result::Result<Answers, (Stage, String)> {
        let user_prompt = clarity::build_prompt(text, prior);
        let reply = match &choice.source {
            Source::Api(connection) => {
                let reply = super::runtime::block_on(async {
                    tokio::time::timeout(
                        CALL_TIMEOUT,
                        super::api_host::run_provider_prompt(
                            connection,
                            &choice.model,
                            clarity::SYSTEM_PROMPT,
                            &user_prompt,
                            None,
                            |_| {},
                        ),
                    )
                    .await
                });
                match reply {
                    Err(_) => {
                        return Err((Stage::ProviderRequest, "The request timed out.".into()));
                    }
                    Ok(Err(error)) => return Err((Stage::ProviderRequest, error)),
                    Ok(Ok((reply, _usage))) => reply,
                }
            }
            Source::Cli { command, args } => {
                let cwd = super::ai_models::working_directory_for(host);
                super::runtime::block_on(super::acp_one_shot::prompt_once(
                    command,
                    args.clone(),
                    &cwd,
                    Some(choice.model.as_str()),
                    &format!("{}\n\n{user_prompt}", clarity::SYSTEM_PROMPT),
                    CALL_TIMEOUT,
                ))
                .map_err(|error| (Stage::ProviderRequest, error))?
            }
        };
        reply_chars = reply.chars().count();
        stage = Stage::ResponseValidation;
        let answers = clarity::parse_answers(&reply, text, prior).map_err(|e| (stage, e))?;
        stage = Stage::CacheWrite;
        remember_answers(dir, &key, &model, &answers).map_err(|e| (stage, e.message))?;
        Ok(answers)
    })();
    if let Ok(mut flight) = in_flight().lock() {
        flight.retain(|k| k != &key);
    }
    match outcome {
        Ok(answers) => {
            log_line(
                host,
                &check_id,
                &model,
                stage,
                started,
                prompt_chars,
                reply_chars,
                "completed",
                json!({}),
            );
            assessment(
                "checked",
                Some(&model),
                json!({ "cached": false, "answers": answers }),
            )
        }
        Err((failed_stage, error)) => {
            let reason = diagnostics::failure(
                failed_stage,
                &error,
                matches!(choice.source, Source::Cli { .. }),
            );
            let status = regex::Regex::new(r"\b[45]\d{2}\b")
                .ok()
                .and_then(|r| r.find(&error).map(|m| m.as_str().to_owned()));
            let mut extra = json!({ "reason": reason, "detail": diagnostics::diagnostic(failed_stage, &error), "errorName": "Error" });
            if let Some(status) = status {
                extra["status"] = json!(status);
            }
            log_line(
                host,
                &check_id,
                &model,
                failed_stage,
                started,
                prompt_chars,
                reply_chars,
                "failed",
                extra,
            );
            assessment("unavailable", Some(&model), json!({ "reason": reason }))
        }
    }
}

// ── evaluations ──────────────────────────────────────────────────────────────────────────────

fn strings(value: &Value) -> Option<Vec<String>> {
    value.as_array().map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

fn evaluate_prompt(host: &HostContext, dir: &Path, request: &Value) -> Result<Value> {
    let follow_up = request["followUpOfIssueKey"]
        .as_str()
        .filter(|k| !k.is_empty())
        .and_then(|k| super::session_store::store(dir).get(k).ok().flatten());
    let prior = follow_up.as_ref().map(derive_prior_context);
    let prompt = request["promptText"].as_str().unwrap_or_default();
    let working_directory = request["workingDirectory"].as_str();
    let catalog = catalog(host, dir);
    let hints = workspace_hints(working_directory, prompt);
    let clarity = assess_prompt(
        host,
        dir,
        prompt,
        prior.as_ref(),
        request["checkClarity"].as_bool().unwrap_or(false),
    );
    let input = EvaluationInput {
        kind: "prompt-readiness".into(),
        prompt_text: prompt.to_owned(),
        tool_mode: request["toolMode"].as_str().map(str::to_owned),
        session_mode: request["sessionMode"].as_str().map(str::to_owned),
        profile_id: request["profileId"].as_str().map(str::to_owned),
        active_skills: strings(&request["activeSkills"]),
        issue_key: request["issueKey"].as_str().map(str::to_owned),
        context_tokens: request["contextTokens"].as_f64(),
        context_limit: request["contextLimit"].as_f64(),
        available_skills: catalog.skills,
        available_agents: catalog.agents,
        configured_mcp_servers: catalog.mcp_servers,
        code_intelligence_available: Some(code_intelligence_enabled(host, working_directory)),
        tracker_tools_available: request["issueKey"].as_str().is_some_and(|k| !k.is_empty()),
        browser_tools_available: true,
        prior_context: prior,
        workspace_hints: hints,
        clarity: Some(clarity),
        evaluated_at: Some(now()),
        ..EvaluationInput::default()
    };
    Ok(remember(evaluate(&input)))
}

fn run_session_evaluation(
    host: &HostContext,
    dir: &Path,
    issue_key: &str,
    turn_index: Option<usize>,
    override_feedback: Option<Value>,
) -> Result<Value> {
    let sessions = super::session_store::store(dir);
    let record = sessions
        .get(issue_key)?
        .ok_or_else(|| failure(format!("No agent session found for {issue_key}.")))?;
    let record_key = record["issueKey"].as_str().unwrap_or(issue_key).to_owned();
    let user_feedback = override_feedback.or_else(|| {
        feedback_store::get_user_feedback(&read_store(dir), &record_key, turn_index).cloned()
    });
    let events: Vec<Value> = record["events"].as_array().cloned().unwrap_or_default();
    let scoped = praxis_ai::feedback::execution::select_turn_events(&events, turn_index);
    let turn_prompt =
        turn_index.and_then(|_| scoped.iter().find(|e| e["type"] == "user_input_completed"));
    let non_empty = |v: Option<&str>| {
        v.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let goal_prompt = non_empty(turn_prompt.and_then(|e| e["detail"].as_str()))
        .or_else(|| non_empty(turn_prompt.and_then(|e| e["summary"].as_str())))
        .or_else(|| record["taskDefinition"]["goal"].as_str().map(str::to_owned))
        .unwrap_or_default();
    // An earlier turn must never inherit messages from that turn or its future.
    let start_index = turn_index.and_then(|_| {
        scoped
            .first()
            .and_then(|first| events.iter().position(|e| e == first))
    });
    let prior = start_index.filter(|i| *i > 0).map(|i| {
        let mut earlier = record.clone();
        earlier["events"] = json!(&events[..i]);
        derive_prior_context(&earlier)
    });
    let folder = record["worktreePath"]
        .as_str()
        .filter(|p| !p.is_empty())
        .or_else(|| record["workingDirectory"].as_str());
    let catalog = catalog(host, dir);
    let hints = workspace_hints(folder, &goal_prompt);
    let clarity = assess_prompt(host, dir, &goal_prompt, prior.as_ref(), true);
    let used_code_intelligence = events.iter().any(|e| {
        regex::Regex::new(r"(?i)code[_-]?intelligence|find_symbol|search_code")
            .is_ok_and(|r| r.is_match(e["data"]["toolName"].as_str().unwrap_or_default()))
    });
    let input = EvaluationInput {
        kind: "session-execution".into(),
        prompt_text: goal_prompt,
        prior_context: prior,
        issue_key: Some(record_key.clone()),
        session_id: record["sessionId"].as_str().map(str::to_owned),
        turn_index,
        available_skills: catalog.skills,
        available_agents: catalog.agents,
        configured_mcp_servers: catalog.mcp_servers,
        code_intelligence_available: Some(
            code_intelligence_enabled(host, folder) || used_code_intelligence,
        ),
        tracker_tools_available: record["connectionId"]
            .as_str()
            .is_some_and(|c| !c.is_empty()),
        browser_tools_available: true,
        user_feedback,
        workspace_hints: hints,
        clarity: Some(clarity),
        evaluated_at: Some(now()),
        session: Some(record),
        ..EvaluationInput::default()
    };
    let report = remember(evaluate(&input));
    with_store(dir, |state| {
        feedback_store::save_report(state, &record_key, &report, turn_index);
        Ok(())
    })?;
    if turn_index.is_none() {
        let summary = feedback_store::session_summary(&report);
        if let Some(updated) =
            sessions.mutate(&record_key, true, |r| r["feedbackSummary"] = summary)?
        {
            host.events().emit("ai:sessionChanged", Some(updated));
        }
    }
    Ok(report)
}

fn turn_index_of(value: &Value) -> Option<usize> {
    value.as_u64().map(|n| n as usize)
}

fn submit_feedback(host: &HostContext, dir: &Path, request: &Value) -> Result<Value> {
    let issue_key = request["issueKey"]
        .as_str()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .or_else(|| {
            request["sessionId"]
                .as_str()
                .map(str::trim)
                .filter(|k| !k.is_empty())
        });
    let created = now();
    let turn_index = turn_index_of(&request["turnIndex"]);
    let tags = request["frictionTags"]
        .as_array()
        .filter(|t| !t.is_empty())
        .cloned();
    let notes = request["notes"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let with_extras = |mut feedback: Value| {
        if let Some(tags) = &tags {
            feedback["frictionTags"] = json!(tags);
        }
        if let Some(notes) = notes {
            feedback["notes"] = json!(notes);
        }
        feedback
    };
    if let Some(issue_key) = issue_key {
        let record = super::session_store::store(dir).get(issue_key)?;
        let prompt_text = request["promptText"]
            .as_str()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .or_else(|| {
                record
                    .as_ref()
                    .and_then(|r| r["taskDefinition"]["goal"].as_str())
            })
            .unwrap_or_default();
        let key = record
            .as_ref()
            .and_then(|r| r["issueKey"].as_str())
            .unwrap_or(issue_key)
            .to_owned();
        let mut feedback = json!({
            "targetKind": if turn_index.is_some() { "turn" } else { "session" }, "issueKey": key,
            "promptText": prompt_text, "verdict": request["verdict"], "createdAt": created,
        });
        if let Some(id) = record
            .as_ref()
            .and_then(|r| r["sessionId"].as_str())
            .or_else(|| request["sessionId"].as_str())
        {
            feedback["sessionId"] = json!(id);
        }
        if let Some(turn) = turn_index {
            feedback["turnIndex"] = json!(turn);
        }
        let feedback = with_extras(feedback);
        with_store(dir, |state| {
            feedback_store::save_user_feedback(state, &key, &feedback, turn_index);
            Ok(())
        })?;
        if record.is_some() {
            return run_session_evaluation(host, dir, &key, turn_index, Some(feedback));
        }
    }
    let catalog = catalog(host, dir);
    let prompt = request["promptText"].as_str().unwrap_or_default();
    let feedback = with_extras(
        json!({ "targetKind": "prompt", "promptText": prompt, "verdict": request["verdict"], "createdAt": created }),
    );
    let input = EvaluationInput {
        kind: "prompt-readiness".into(),
        prompt_text: prompt.to_owned(),
        available_skills: catalog.skills,
        available_agents: catalog.agents,
        configured_mcp_servers: catalog.mcp_servers,
        code_intelligence_available: Some(code_intelligence_enabled(host, None)),
        browser_tools_available: true,
        user_feedback: Some(feedback),
        evaluated_at: Some(created),
        ..EvaluationInput::default()
    };
    let report = remember(evaluate(&input));
    let id = report["reportId"].as_str().unwrap_or_default().to_owned();
    with_store(dir, |state| {
        feedback_store::save_report(state, &id, &report, None);
        Ok(())
    })?;
    Ok(report)
}

/// The deterministic template upgrade; no model is asked to rewrite.
fn rewrite_from_feedback(host: &HostContext, dir: &Path, request: &Value) -> Result<Value> {
    let issue_key = request["issueKey"].as_str().filter(|k| !k.is_empty());
    let turn_index = turn_index_of(&request["turnIndex"]);
    let mut report = if let Some(issue_key) = issue_key {
        run_session_evaluation(host, dir, issue_key, turn_index, None)?
    } else {
        let catalog = catalog(host, dir);
        remember(evaluate(&EvaluationInput {
            kind: "prompt-readiness".into(),
            prompt_text: request["promptText"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            tool_mode: request["toolMode"].as_str().map(str::to_owned),
            session_mode: request["sessionMode"].as_str().map(str::to_owned),
            profile_id: request["profileId"].as_str().map(str::to_owned),
            active_skills: strings(&request["activeSkills"]),
            available_skills: catalog.skills,
            available_agents: catalog.agents,
            configured_mcp_servers: catalog.mcp_servers,
            code_intelligence_available: Some(code_intelligence_enabled(host, None)),
            browser_tools_available: true,
            evaluated_at: Some(now()),
            ..EvaluationInput::default()
        }))
    };
    let titles: Vec<String> = report["findings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f["title"].as_str().map(str::to_owned))
        .collect();
    let rationale = if titles.is_empty() {
        "Prompt is already well-structured with clear scope and verification criteria.".to_owned()
    } else {
        format!(
            "Addressed {} deterministic finding{}: {}.",
            titles.len(),
            if titles.len() == 1 { "" } else { "s" },
            titles
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join("; ")
        )
    };
    let suggested = report["suggestedPrompt"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let findings: Vec<praxis_ai::feedback::types::Finding> =
                serde_json::from_value(report["findings"].clone()).unwrap_or_default();
            praxis_ai::feedback::build_suggested_prompt(
                report["promptText"].as_str().unwrap_or_default(),
                &findings,
                "prompt-readiness",
            )
        });
    report["aiRewrite"] = json!({ "rewrittenPrompt": suggested, "rationale": rationale, "deterministicFallback": true });
    if let Some(issue_key) = issue_key {
        with_store(dir, |state| {
            feedback_store::save_report(state, issue_key, &report, turn_index);
            Ok(())
        })?;
    }
    Ok(report)
}

pub fn dispatch(
    host: &HostContext,
    dir: &Path,
    channel: &str,
    args: &[Value],
) -> Option<Result<Value>> {
    let first = args.first().unwrap_or(&Value::Null);
    Some(match channel {
        "ai:evaluatePrompt" => evaluate_prompt(host, dir, first),
        "ai:evaluateSession" => {
            let (issue_key, turn) = match first {
                Value::String(key) => (key.as_str(), args.get(1).and_then(Value::as_u64)),
                other => (
                    other["issueKey"].as_str().unwrap_or_default(),
                    other["turnIndex"].as_u64(),
                ),
            };
            run_session_evaluation(host, dir, issue_key, turn.map(|t| t as usize), None)
        }
        "ai:getSessionFeedback" => (|| {
            let issue_key = text(args, 0)?;
            let turn = args.get(1).and_then(Value::as_u64).map(|t| t as usize);
            let existing = feedback_store::get_report(&read_store(dir), issue_key, turn).cloned();
            if let Some(report) = &existing
                && report["rubricVersion"] == SCORING_RUBRIC_VERSION
                && !report["rehearsal"].is_null()
            {
                return Ok(remember(report.clone()));
            }
            // A report scored under an older rubric is re-evaluated rather than shown stale
            if super::session_store::store(dir).get(issue_key)?.is_none() {
                return Ok(existing.unwrap_or(Value::Null));
            }
            run_session_evaluation(host, dir, issue_key, turn, None)
        })(),
        "ai:submitSessionFeedback" => submit_feedback(host, dir, first),
        "ai:rewritePromptFromFeedback" => rewrite_from_feedback(host, dir, first),
        "ai:getFindingFeedback" => {
            text(args, 0).map(|digest| feedback_store::finding_feedback(&read_store(dir), digest))
        }
        "ai:reviewFinding" => (|| {
            let digest = first["inputDigest"].as_str();
            if digest.is_none()
                || first["findingId"].as_str().is_none()
                || (!first["muted"].is_null() && !first["muted"].is_boolean())
            {
                return Err(failure("Invalid finding review."));
            }
            let digest = digest.unwrap_or_default();
            let report = recent_reports()
                .lock()
                .ok()
                .and_then(|r| r.0.get(digest).cloned())
                .or_else(|| {
                    feedback_store::list_reports(&read_store(dir))
                        .into_iter()
                        .find(|r| r["inputDigest"] == digest)
                        .cloned()
                });
            let report = report.ok_or_else(|| {
                failure("This assessment has expired. Check the prompt again before rating it.")
            })?;
            with_store(dir, |state| {
                feedback_store::review_finding(state, &report, first, &now())
            })
        })(),
        _ => return None,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_paths_are_relative_to_the_folder() {
        let status =
            " M src/A.tsx\n?? e2e/b.spec.ts\nR  old.ts -> \"src/new.ts\"\n M ../outside.ts\n";
        let files = parse_status(status, Path::new("/repo"), Path::new("/repo"));
        assert_eq!(files, vec!["src/A.tsx", "e2e/b.spec.ts", "src/new.ts"]);
        assert_eq!(
            parse_status(
                " M packages/x.ts\n M other/y.ts\n",
                Path::new("/repo"),
                Path::new("/repo/packages")
            ),
            vec!["x.ts"]
        );
    }

    #[test]
    fn assessment_shapes() {
        let pending = assessment("pending", Some("a/b"), json!({}));
        assert_eq!(
            pending,
            json!({ "status": "pending", "checklistVersion": 4, "model": "a/b" })
        );
        assert_eq!(
            assessment("unavailable", None, json!({ "reason": "x" }))["reason"],
            "x"
        );
    }

    #[test]
    fn recent_reports_are_bounded() {
        for index in 0..140 {
            remember(json!({ "inputDigest": format!("digest-{index}") }));
        }
        let recent = recent_reports().lock().unwrap();
        assert!(recent.0.len() <= 128);
        assert!(recent.0.contains_key("digest-139"));
        assert!(!recent.0.contains_key("digest-0"));
    }

    #[test]
    fn workspace_facts_come_from_git_and_the_manifest() {
        let dir = std::env::temp_dir().join(format!("praxis-fb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("e2e")).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"test":"x","check-types":"y"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("e2e/a.spec.ts"), "//").unwrap();
        let run = |args: &[&str]| {
            Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(args)
                .current_dir(&dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
        };
        run(&["init", "-q"]);
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", "x"]);
        std::fs::write(dir.join("new.ts"), "//").unwrap();
        let hints = gather_hints(dir.to_str().unwrap()).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(hints.changed_files, vec!["new.ts"]);
        assert_eq!(hints.test_files, vec!["e2e/a.spec.ts"]);
        let mut scripts = hints.package_scripts.clone();
        scripts.sort();
        assert_eq!(scripts, vec!["check-types", "test"]);
    }
}
