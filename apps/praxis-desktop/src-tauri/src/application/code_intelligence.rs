//! Integration with the local code-intelligence service (`services/code-intelligence`):
//! the `ai:codeIntelligence` channel, model installation/activation, repository lookups for
//! prompt feedback, startup maintenance and the stdio MCP server handed to agent sessions
//! (port of the retired `codeIntelligenceIpc.ts`, `codeIntelligenceSession.ts` and
//! `codeIntelligenceCleanup.ts`).
//!
//! The service is a .NET CLI that owns a background process; every call here is a short-lived
//! `Praxis.CodeIntelligence <verb> --data <dir>` invocation answering one JSON envelope.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use praxis_host::HostContext;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{Result, failure};

const ACTIONS: [&str; 18] = [
    "list",
    "register",
    "index",
    "rebuild",
    "relocate",
    "pause",
    "resume",
    "unregister",
    "query",
    "connect",
    "revoke",
    "model-install",
    "model-activate",
    "owner-status",
    "owner-start",
    "owner-stop",
    "owner-restart",
    "cleanup",
];
const TOOLS: [&str; 14] = [
    "search_code",
    "find_symbol",
    "get_symbol",
    "get_source",
    "explain_symbol",
    "get_callers",
    "get_callees",
    "trace_flow",
    "find_related",
    "summarize_project",
    "get_index_status",
    "search_knowledge",
    "get_knowledge_section",
    "find_related_knowledge",
];
const INVOKE_TIMEOUT: Duration = Duration::from_secs(125);
const MAX_OUTPUT: u64 = 1024 * 1024;
const SYMBOL_CACHE_TTL: Duration = Duration::from_secs(60);

/// How to start the service: a self-contained executable, or `dotnet <assembly>`.
#[derive(Clone, Debug)]
pub(super) struct Runtime {
    pub executable: String,
    pub assembly: Option<String>,
    pub contracts: PathBuf,
}

pub(super) fn data_directory(host: &HostContext) -> PathBuf {
    if let Ok(dir) = std::env::var("PRAXIS_CODE_INTELLIGENCE_DATA_DIRECTORY")
        && !dir.is_empty()
    {
        return PathBuf::from(dir);
    }
    // A per-test settings file keeps the index beside it instead of in the real profile.
    if std::env::var("PRAXIS_SETTINGS_PATH").is_ok()
        && let Some(parent) = host.config().settings_path.parent()
    {
        return parent.join("code-intelligence");
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    if cfg!(target_os = "windows") {
        let base = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Local"));
        base.join("Praxis").join("code-intelligence")
    } else if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Praxis")
            .join("code-intelligence")
    } else {
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .ok()
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".local").join("share"));
        base.join("Praxis").join("code-intelligence")
    }
}

pub(super) fn service() -> std::result::Result<Runtime, String> {
    let exe_name = if cfg!(windows) {
        "Praxis.CodeIntelligence.exe"
    } else {
        "Praxis.CodeIntelligence"
    };
    let native = std::env::var("PRAXIS_CODE_INTELLIGENCE_EXE")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            // A packaged app ships the service beside itself.
            let beside = std::env::current_exe()
                .ok()?
                .parent()?
                .join("code-intelligence")
                .join(exe_name);
            beside.exists().then_some(beside)
        });
    if let Some(native) = native {
        if !native.exists() {
            return Err("Code intelligence service is not installed.".into());
        }
        let contracts = native
            .parent()
            .unwrap_or(Path::new("."))
            .join("contracts.json");
        return Ok(Runtime {
            executable: native.to_string_lossy().into_owned(),
            assembly: None,
            contracts,
        });
    }
    let assembly = std::env::var("PRAXIS_CODE_INTELLIGENCE_DLL")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join(
                "../../../services/code-intelligence/src/Praxis.CodeIntelligence/bin/Debug/net10.0/Praxis.CodeIntelligence.dll",
            )
        });
    if !assembly.exists() {
        return Err(
            "Build the code intelligence service with npm run build:code-intelligence.".into(),
        );
    }
    let contracts = assembly
        .parent()
        .unwrap_or(Path::new("."))
        .join("contracts.json");
    Ok(Runtime {
        executable: std::env::var("PRAXIS_DOTNET").unwrap_or_else(|_| "dotnet".into()),
        assembly: Some(assembly.to_string_lossy().into_owned()),
        contracts,
    })
}

fn envelope_error(code: &str, message: impl Into<String>) -> Value {
    json!({ "error": { "code": code, "message": message.into() } })
}

/// Runs the service CLI once and parses its JSON envelope. `Err` is a failure the CLI could not
/// express as JSON (its first stderr line is kept so the cause is visible).
fn invoke(
    host: &HostContext,
    args: &[&str],
    input: Option<&Value>,
) -> std::result::Result<Value, String> {
    let runtime = service()?;
    invoke_with(&runtime, &data_directory(host), args, input)
}

pub(super) fn invoke_with(
    runtime: &Runtime,
    data: &Path,
    args: &[&str],
    input: Option<&Value>,
) -> std::result::Result<Value, String> {
    let mut command = Command::new(&runtime.executable);
    if let Some(assembly) = &runtime.assembly {
        command.arg(assembly);
    }
    command.args(args).arg("--data").arg(data);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Local code intelligence service could not start: {e}"))?;
    if let Some(mut stdin) = child.stdin.take()
        && let Some(input) = input
    {
        let _ = stdin.write_all(input.to_string().as_bytes());
    }
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let out_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = (&mut stdout).take(MAX_OUTPUT).read_to_end(&mut buffer);
        buffer
    });
    let err_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = (&mut stderr).take(16 * 1024).read_to_end(&mut buffer);
        buffer
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) if started.elapsed() > INVOKE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
        }
    }
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    serde_json::from_slice::<Value>(&out).map_err(|_| {
        let reason = String::from_utf8_lossy(&err)
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(|l| l.chars().take(300).collect::<String>());
        match reason {
            Some(reason) => format!(
                "Local code intelligence service could not complete this operation: {reason}"
            ),
            None => "Local code intelligence service could not complete this operation.".into(),
        }
    })
}

fn call(host: &HostContext, args: &[&str], input: Option<&Value>) -> Value {
    invoke(host, args, input)
        .unwrap_or_else(|message| envelope_error("CAPABILITY_UNAVAILABLE", message))
}

fn text(value: &Value, maximum: usize) -> std::result::Result<&str, String> {
    match value.as_str() {
        Some(s) if !s.is_empty() && s.len() <= maximum && !s.contains('\0') => Ok(s),
        _ => Err("Invalid code intelligence argument.".into()),
    }
}

fn has_error(response: &Value) -> bool {
    !response["error"].is_null()
}

// ── model installation ───────────────────────────────────────────────────────────────────────

fn installed_model_fingerprint(host: &HostContext, user_data_dir: &Path) -> Option<String> {
    if let Some(cached) = super::semantic_model::cached_fingerprint() {
        return Some(cached);
    }
    if !super::semantic_model::is_model_installed(user_data_dir) {
        return None;
    }
    let dir = super::semantic_model::model_directory(user_data_dir);
    let installed = invoke(host, &["model-install", &dir.to_string_lossy()], None).ok()?;
    let fingerprint = installed["data"]["fingerprint"].as_str()?.to_owned();
    super::semantic_model::set_cached_fingerprint(&fingerprint);
    Some(fingerprint)
}

fn registered_repository_ids(host: &HostContext) -> Vec<String> {
    call(host, &["list"], None)["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect()
}

/// Activates the model for each repository that has it neither active nor building and returns
/// the failures. Vector search answers MODEL_UNAVAILABLE until a repository is activated.
fn activate_model(host: &HostContext, fingerprint: &str, repository_ids: &[String]) -> Vec<String> {
    let mut failures = Vec::new();
    for repository_id in repository_ids {
        let status = invoke(
            host,
            &["local-rpc"],
            Some(&json!({ "tool": "get_index_status", "arguments": { "repositoryId": repository_id, "responseBudgetTokens": 8000 } })),
        )
        .ok();
        let covered = status
            .as_ref()
            .and_then(|s| s["data"]["models"].as_array())
            .is_some_and(|models| {
                models.iter().any(|m| {
                    m["fingerprint"] == fingerprint
                        && matches!(m["state"].as_str(), Some("active" | "building"))
                })
            });
        if covered {
            continue;
        }
        match invoke(host, &["model-activate", repository_id, fingerprint], None) {
            Ok(response) if has_error(&response) => failures.push(
                response["error"]["message"]
                    .as_str()
                    .unwrap_or("Model activation failed.")
                    .to_owned(),
            ),
            Err(message) => failures.push(message),
            Ok(_) => {}
        }
    }
    failures
}

// ── owner lifecycle ──────────────────────────────────────────────────────────────────────────

fn owner_status(host: &HostContext) -> Value {
    let status = call(host, &["owner-status"], None);
    if has_error(&status) {
        return status;
    }
    let version = call(host, &["version"], None);
    let mut data = status["data"].clone();
    if !data.is_object() {
        data = json!({});
    }
    let current = version["data"]["build"].as_str().map(str::to_owned);
    let running = data["running"] == true;
    let outdated = running
        && current
            .as_deref()
            .is_some_and(|c| data["build"].as_str() != Some(c));
    if let Some(current) = current {
        data["currentBuild"] = json!(current);
    }
    data["outdated"] = json!(outdated);
    // Whether anything was ever indexed here, so a caller can decide whether starting is worth it.
    data["hasIndex"] = json!(data_directory(host).join("index.db").exists());
    json!({ "data": data })
}

fn owner_start(host: &HostContext) -> Value {
    let started = call(host, &["list"], None);
    if has_error(&started) {
        started
    } else {
        owner_status(host)
    }
}

fn owner_stop(host: &HostContext) -> Value {
    let stopped = call(host, &["stop"], None);
    if has_error(&stopped) {
        stopped
    } else {
        owner_status(host)
    }
}

fn owner_restart(host: &HostContext) -> Value {
    let stopped = call(host, &["stop"], None);
    if has_error(&stopped) {
        stopped
    } else {
        owner_start(host)
    }
}

// ── removed-worktree cleanup ─────────────────────────────────────────────────────────────────

fn git_output(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Only collect removed Praxis worktrees; an unavailable ordinary folder is not proof of deletion.
fn removed_worktree(root: &str) -> bool {
    let path = Path::new(root);
    let parent = path.parent();
    if !path.is_absolute()
        || parent.and_then(|p| p.file_name()).and_then(|n| n.to_str()) != Some(".worktrees")
        || std::fs::symlink_metadata(path).is_ok()
    {
        return false;
    }
    let Some(repository) = parent.and_then(Path::parent) else {
        return false;
    };
    let Some(top) = git_output(repository, &["rev-parse", "--show-toplevel"]) else {
        return false;
    };
    if std::fs::canonicalize(top.trim()).ok() != std::fs::canonicalize(repository).ok() {
        return false;
    }
    let listing = git_output(repository, &["worktree", "list", "--porcelain"]).unwrap_or_default();
    let wanted = format!("worktree {root}");
    let record = listing
        .split("\n\n")
        .find(|block| block.lines().any(|l| l == wanted));
    if let Some(record) = record {
        // A checkout may be temporarily unavailable. Keep it while its Git registration and
        // branch still exist.
        let Some(branch) = record.lines().find_map(|l| l.strip_prefix("branch ")) else {
            return false;
        };
        if git_output(repository, &["show-ref", "--verify", "--quiet", branch]).is_some() {
            return false;
        }
    }
    // Recheck immediately before unregistering in case a checkout was recreated.
    std::fs::symlink_metadata(path).is_err()
}

fn cleanup_removed_worktrees(
    host: &HostContext,
    warnings: &mut Vec<Value>,
) -> std::result::Result<Vec<String>, String> {
    let listed = call(host, &["list"], None);
    if has_error(&listed) {
        return Err(listed["error"]["message"]
            .as_str()
            .unwrap_or("Listing failed.")
            .to_owned());
    }
    let Some(list) = listed["data"].as_array() else {
        return Err("Invalid code intelligence repository list.".into());
    };
    let mut removed = Vec::new();
    for repository in list {
        let (Some(id), Some(root)) = (repository["id"].as_str(), repository["root"].as_str())
        else {
            continue;
        };
        if !removed_worktree(root) {
            continue;
        }
        let result = call(host, &["unregister", id], None);
        if has_error(&result) {
            warnings.push(json!({ "code": "CLEANUP_SKIPPED", "message": format!("Could not clean up code intelligence index for {root}: {}", result["error"]["message"].as_str().unwrap_or("")) }));
        } else {
            removed.push(id.to_owned());
        }
    }
    Ok(removed)
}

/// Maintenance runs once after launch, against the current owner, without delaying startup:
/// an owner left running by an earlier build is replaced, and indexes of removed worktrees go.
pub fn maintain_on_startup(host: &HostContext) {
    if service().is_err() {
        return;
    }
    if owner_status(host)["data"]["outdated"] == true {
        let _ = owner_restart(host);
    }
    if !data_directory(host).join("index.db").exists() {
        return;
    }
    let mut warnings = Vec::new();
    let _ = cleanup_removed_worktrees(host, &mut warnings);
}

// ── channel handlers ─────────────────────────────────────────────────────────────────────────

fn handle_request(
    host: &HostContext,
    user_data_dir: &Path,
    request: &Value,
) -> std::result::Result<Value, String> {
    let action = request["action"].as_str().unwrap_or_default();
    if !ACTIONS.contains(&action) || request.to_string().len() > 1024 * 1024 {
        return Err("Invalid code intelligence request.".into());
    }
    let id = || text(&request["repositoryId"], 512);
    match action {
        "list" => Ok(call(host, &["list"], None)),
        "cleanup" => {
            let mut warnings = Vec::new();
            let removed = cleanup_removed_worktrees(host, &mut warnings)?;
            Ok(json!({ "data": { "removedCount": removed.len() }, "warnings": warnings }))
        }
        "register" => {
            let root = text(&request["root"], 4096)?;
            let mut args = vec!["register", root];
            if !request["manifest"].is_null() {
                args.extend(["--manifest", text(&request["manifest"], 4096)?]);
            }
            let excludes: String = match request["excludes"].as_array() {
                Some(list) if list.len() > 100 => return Err("Too many exclusions.".into()),
                Some(list) => list
                    .iter()
                    .map(|v| text(v, 4096))
                    .collect::<std::result::Result<Vec<_>, _>>()?
                    .join(";"),
                None => String::new(),
            };
            if !excludes.is_empty() {
                args.extend(["--exclude", &excludes]);
            }
            let registered = call(host, &args, None);
            let Some(repository_id) = registered["data"]["repositoryId"]
                .as_str()
                .map(str::to_owned)
            else {
                return Ok(registered);
            };
            if has_error(&registered) {
                return Ok(registered);
            }
            // A repository added after the model was installed needs it activated too.
            let failures = installed_model_fingerprint(host, user_data_dir)
                .map(|fp| activate_model(host, &fp, std::slice::from_ref(&repository_id)))
                .unwrap_or_default();
            if failures.is_empty() {
                return Ok(registered);
            }
            let mut result = registered;
            let mut warnings = result["warnings"].as_array().cloned().unwrap_or_default();
            warnings.extend(
                failures
                    .into_iter()
                    .map(|m| json!({ "code": "MODEL_ACTIVATION_FAILED", "message": m })),
            );
            result["warnings"] = Value::Array(warnings);
            Ok(result)
        }
        "relocate" => {
            let mut args = vec!["relocate", id()?, text(&request["root"], 4096)?];
            if !request["manifest"].is_null() {
                args.extend(["--manifest", text(&request["manifest"], 4096)?]);
            }
            Ok(call(host, &args, None))
        }
        "query" => {
            let tool = text(&request["tool"], 64)?;
            if !TOOLS.contains(&tool) {
                return Err("Unknown query tool.".into());
            }
            if !request["arguments"].is_object() {
                return Err("Query arguments are required.".into());
            }
            Ok(call(
                host,
                &["local-rpc"],
                Some(&json!({ "tool": tool, "arguments": request["arguments"] })),
            ))
        }
        "connect" => {
            let repository = id()?;
            let provider = text(&request["provider"], 128)?;
            let runtime = service()?;
            if !runtime.contracts.exists() {
                return Err("Code intelligence contracts are missing.".into());
            }
            let grant = call(host, &["grant", repository, "--client", provider], None);
            if has_error(&grant) {
                return Ok(grant);
            }
            let mut server = session_server_config(host, &runtime, repository, provider, None);
            server["requireApproval"] = json!(true);
            server["name"] = json!(format!(
                "Code intelligence {}",
                &server["id"].as_str().unwrap_or_default()["praxis-code-intelligence-".len()..]
                    .chars()
                    .take(8)
                    .collect::<String>()
            ));
            Ok(json!({ "mcpServer": server }))
        }
        "revoke" => Ok(call(
            host,
            &[
                "revoke",
                id()?,
                "--client",
                text(&request["provider"], 128)?,
            ],
            None,
        )),
        "model-install" => Ok(call(
            host,
            &["model-install", text(&request["bundle"], 4096)?],
            None,
        )),
        "model-activate" => Ok(call(
            host,
            &["model-activate", id()?, text(&request["fingerprint"], 71)?],
            None,
        )),
        "owner-status" => Ok(owner_status(host)),
        "owner-start" => Ok(owner_start(host)),
        "owner-stop" => Ok(owner_stop(host)),
        "owner-restart" => Ok(owner_restart(host)),
        other => Ok(call(host, &[other, id()?], None)),
    }
}

pub fn handle(host: &HostContext, user_data_dir: &Path, args: &[Value]) -> Value {
    handle_request(host, user_data_dir, args.first().unwrap_or(&Value::Null))
        .unwrap_or_else(|message| envelope_error("CAPABILITY_UNAVAILABLE", message))
}

static CAUGHT_UP: Mutex<bool> = Mutex::new(false);

/// `ai:getSemanticModelStatus`: installs the downloaded bundle into the service the first time
/// the session needs it and activates it for repositories registered before the model existed.
pub fn semantic_status(host: &HostContext, user_data_dir: &Path) -> Value {
    if service().is_ok()
        && let Some(fingerprint) = installed_model_fingerprint(host, user_data_dir)
    {
        let first = CAUGHT_UP
            .lock()
            .map(|mut c| !std::mem::replace(&mut *c, true))
            .unwrap_or(false);
        if first {
            let failures = activate_model(host, &fingerprint, &registered_repository_ids(host));
            if !failures.is_empty() {
                eprintln!("Semantic model activation failed: {}", failures.join("; "));
            }
        }
    }
    super::semantic_model::status(user_data_dir)
}

/// After a download: the service must accept the bundle, and every repository gets it activated.
pub fn install_downloaded_model(host: &HostContext, user_data_dir: &Path) -> Result<()> {
    if service().is_err() {
        return Ok(());
    }
    let dir = super::semantic_model::model_directory(user_data_dir);
    let installed = call(host, &["model-install", &dir.to_string_lossy()], None);
    if has_error(&installed) {
        return Err(failure(format!(
            "The local code intelligence service did not install the model: {}",
            installed["error"]["message"]
                .as_str()
                .unwrap_or("unknown error")
        )));
    }
    if let Some(fingerprint) = installed["data"]["fingerprint"].as_str() {
        super::semantic_model::set_cached_fingerprint(fingerprint);
        let failures = activate_model(host, fingerprint, &registered_repository_ids(host));
        if !failures.is_empty() {
            return Err(failure(format!(
                "The model is installed but could not be activated: {}",
                failures.join("; ")
            )));
        }
    }
    Ok(())
}

/// `ai:resetCodeIntelligence`: removes the model, the index data and the granted MCP servers.
pub fn reset(host: &HostContext, user_data_dir: &Path) {
    let _ = super::semantic_model::delete(user_data_dir);
    if service().is_ok() {
        let _ = invoke(host, &["stop"], None);
    }
    let dir = data_directory(host);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
    }
    let kept: Vec<Value> = host
        .settings()
        .read()
        .ai
        .mcp_servers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| {
            !s.id.starts_with("praxis-code-intelligence-")
                && !s
                    .env
                    .as_ref()
                    .is_some_and(|e| e.contains_key("PRAXIS_CODE_INTELLIGENCE_PROVIDER"))
        })
        .filter_map(|s| serde_json::to_value(s).ok())
        .collect();
    let _ = super::ai_providers::write_settings(
        host,
        &json!({ "ai": { "codeIntelligence": { "enabled": true, "projectOverrides": {} }, "mcpServers": kept } }),
    );
}

// ── settings rule, symbol lookups ────────────────────────────────────────────────────────────

fn enabled_in_settings(host: &HostContext, folder: Option<&str>) -> bool {
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

/// Whether a session in this folder would get code intelligence tools (read-only: never
/// registers a folder or grants a client).
pub fn is_enabled_for(host: &HostContext, folder: Option<&str>) -> bool {
    enabled_in_settings(host, folder) && service().is_ok_and(|r| r.contracts.exists())
}

type SymbolResult = (String, bool, Option<String>);
type SymbolCache = HashMap<String, (Instant, SymbolResult)>;
static SYMBOL_CACHE: Mutex<Option<SymbolCache>> = Mutex::new(None);
type RepositoryCache = (Instant, Vec<(String, String)>);
static REPOSITORY_CACHE: Mutex<Option<RepositoryCache>> = Mutex::new(None);

fn indexed_repository_id(host: &HostContext, folder: &str) -> Option<String> {
    let mut cache = REPOSITORY_CACHE.lock().ok()?;
    if cache
        .as_ref()
        .is_none_or(|(at, _)| at.elapsed() > SYMBOL_CACHE_TTL)
    {
        let response = invoke(host, &["list"], None).ok()?;
        let list = response["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| Some((r["id"].as_str()?.to_owned(), r["root"].as_str()?.to_owned())))
            .collect();
        *cache = Some((Instant::now(), list));
    }
    let normalized = std::fs::canonicalize(folder).unwrap_or_else(|_| PathBuf::from(folder));
    cache
        .as_ref()?
        .1
        .iter()
        .filter(|(_, root)| {
            let root = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
            normalized.starts_with(&root)
        })
        .max_by_key(|(_, root)| root.len())
        .map(|(id, _)| id.clone())
}

/// Exact-name lookups in the folder's existing code index, for prompt feedback. Read-only: an
/// unindexed folder or a stopped service yields `None` and the names stay unchecked.
pub fn lookup_indexed_symbols(
    host: &HostContext,
    folder: Option<&str>,
    names: &[String],
) -> Option<Vec<praxis_ai::feedback::types::Symbol>> {
    let folder = folder.map(str::trim).filter(|f| !f.is_empty())?;
    if names.is_empty() || !is_enabled_for(host, Some(folder)) {
        return None;
    }
    let repository_id = indexed_repository_id(host, folder)?;
    let mut results = Vec::new();
    for name in names.iter().take(5) {
        let key = format!("{repository_id}\0{name}");
        let cached = SYMBOL_CACHE.lock().ok().and_then(|c| {
            c.as_ref().and_then(|m| {
                m.get(&key)
                    .filter(|(at, _)| at.elapsed() < SYMBOL_CACHE_TTL)
                    .map(|(_, r)| r.clone())
            })
        });
        let (name, found, location) = if let Some(cached) = cached {
            cached
        } else {
            let response = invoke(
                host,
                &["local-rpc"],
                Some(&json!({ "tool": "find_symbol", "arguments": { "repositoryId": repository_id, "name": name, "limit": 1, "freshness": "allow_stale" } })),
            )
            .ok()?;
            if has_error(&response) {
                return None;
            }
            let item = response["data"]["items"].as_array().and_then(|i| i.first());
            let result = (
                name.clone(),
                item.is_some(),
                item.and_then(|i| i["qualifiedName"].as_str())
                    .map(str::to_owned),
            );
            if let Ok(mut cache) = SYMBOL_CACHE.lock() {
                cache
                    .get_or_insert_with(HashMap::new)
                    .insert(key, (Instant::now(), result.clone()));
            }
            result
        };
        results.push(praxis_ai::feedback::types::Symbol {
            name,
            found,
            location,
        });
    }
    Some(results)
}

// ── agent session server ─────────────────────────────────────────────────────────────────────

fn session_server_config(
    host: &HostContext,
    runtime: &Runtime,
    repository_id: &str,
    provider: &str,
    working_directory: Option<&str>,
) -> Value {
    let digest: String = Sha256::digest(json!([repository_id, provider]).to_string().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let id = &digest[..24];
    let mut env = serde_json::Map::new();
    env.insert("PRAXIS_CODE_INTELLIGENCE_PROVIDER".into(), json!(provider));
    env.insert(
        "PRAXIS_CODE_INTELLIGENCE_SETTINGS_PATH".into(),
        json!(host.config().settings_path.to_string_lossy()),
    );
    if let Some(dir) = working_directory {
        env.insert(
            "PRAXIS_CODE_INTELLIGENCE_WORKING_DIRECTORY".into(),
            json!(dir),
        );
    }
    json!({
        "id": format!("praxis-code-intelligence-{id}"),
        "name": praxis_ai::session::prompt::code_intelligence_server_name(),
        "enabled": true, "transport": "stdio", "requireApproval": false,
        "command": std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        "args": [
            super::code_intelligence_bridge::FLAG, runtime.executable,
            runtime.assembly.clone().unwrap_or_else(|| "-".into()),
            data_directory(host).to_string_lossy(), repository_id, provider, runtime.contracts.to_string_lossy()
        ],
        "env": env
    })
}

/// Code and knowledge tools for both folder-backed and folderless agent sessions, as an ACP
/// stdio `mcpServers` entry. The folder is registered, indexed in the background and granted
/// to the provider; if that fails the server still serves previously granted repositories.
pub fn session_server(
    host: &HostContext,
    user_data_dir: &Path,
    working_directory: Option<&str>,
    provider: &str,
) -> Option<Value> {
    if provider.is_empty() || !enabled_in_settings(host, working_directory) {
        return None;
    }
    let runtime = service().ok()?;
    if !runtime.contracts.exists() {
        return None;
    }
    let entry = |repository: &str| {
        let config = session_server_config(host, &runtime, repository, provider, working_directory);
        json!({ "name": config["name"], "command": config["command"], "args": config["args"], "env": config["env"] })
    };
    let Some(folder) = working_directory.filter(|f| !f.is_empty()) else {
        return Some(entry("*"));
    };
    let setup = || -> std::result::Result<String, String> {
        let list = invoke(host, &["list"], None)?;
        if has_error(&list) {
            return Err(list["error"]["message"]
                .as_str()
                .unwrap_or("list failed")
                .into());
        }
        let normalized = std::fs::canonicalize(folder).unwrap_or_else(|_| PathBuf::from(folder));
        let existing = list["data"].as_array().into_iter().flatten().find(|r| {
            r["root"].as_str().is_some_and(|root| {
                root == folder
                    || std::fs::canonicalize(root).ok().as_deref() == Some(normalized.as_path())
            })
        });
        let repository_id = match existing.and_then(|r| r["id"].as_str()) {
            Some(id) => id.to_owned(),
            None => {
                let registered = invoke(host, &["register", folder], None)?;
                if has_error(&registered) {
                    return Err(registered["error"]["message"]
                        .as_str()
                        .unwrap_or("register failed")
                        .into());
                }
                let id = registered["data"]["repositoryId"]
                    .as_str()
                    .ok_or("Repository registration returned no ID.")?
                    .to_owned();
                let (task_host, task_id) = (host.clone(), id.clone());
                std::thread::spawn(move || {
                    if let Ok(result) = invoke(&task_host, &["index", &task_id], None)
                        && has_error(&result)
                    {
                        eprintln!(
                            "Code intelligence indexing failed: {}",
                            result["error"]["message"]
                        );
                    }
                });
                id
            }
        };
        if let Some(fingerprint) = installed_model_fingerprint(host, user_data_dir) {
            let failures = activate_model(host, &fingerprint, std::slice::from_ref(&repository_id));
            if !failures.is_empty() {
                eprintln!("Semantic model activation failed: {}", failures.join("; "));
            }
        }
        let grant = invoke(host, &["grant", &repository_id, "--client", provider], None)?;
        if has_error(&grant) {
            return Err(grant["error"]["message"]
                .as_str()
                .unwrap_or("grant failed")
                .into());
        }
        Ok(repository_id)
    };
    match setup() {
        Ok(repository_id) => Some(entry(&repository_id)),
        Err(error) => {
            eprintln!("Code intelligence folder setup failed; using existing grants: {error}");
            Some(entry("*"))
        }
    }
}
