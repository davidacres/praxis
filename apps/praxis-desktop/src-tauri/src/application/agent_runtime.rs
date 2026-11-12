use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use praxis_host::HostContext;
use serde_json::{Value, json};

use praxis_core::agent_runtime::authoring::{self, CreationPlan, GeneratedFile, NewAgentInput, NewAgentProfileInput, NewSkillInput};
use praxis_core::agent_runtime::native_sources::{self, NativeSourceOptions};
use praxis_core::agent_runtime::{CatalogOptions, bundled, refresh_catalog};

use super::{Result, failure, text};

// ── roots ────────────────────────────────────────────────────────────────

struct Scoped {
    global: PathBuf,
    project: PathBuf,
}

impl Scoped {
    fn get(&self, scope: &str) -> Result<&Path> {
        match scope {
            "global" => Ok(&self.global),
            "project" => Ok(&self.project),
            other => Err(failure(format!("Unknown catalog scope: {other}"))),
        }
    }
    fn json(&self) -> Value {
        json!({ "global": self.global.to_string_lossy(), "project": self.project.to_string_lossy() })
    }
}

struct Roots {
    /// Executable runtime hosts (`agent.json`); also what Settings calls `agents`.
    hosts: Scoped,
    profiles: Scoped,
    skills: Scoped,
}

/// Discovery roots, derived the way the Electron main derived them: the user-data catalog plus
/// the working folder's `.praxis` (settings, then `PRAXIS_AI_WORKING_DIR`, then the cwd).
fn roots(host: &HostContext, user_data_dir: &Path) -> Roots {
    let configured = host.settings().read().ai.working_directory.trim().to_owned();
    let working = if !configured.is_empty() {
        PathBuf::from(configured)
    } else {
        std::env::var("PRAXIS_AI_WORKING_DIR")
            .ok()
            .filter(|dir| !dir.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_default()
    };
    let project = working.join(".praxis");
    Roots {
        hosts: Scoped { global: user_data_dir.join("agents"), project: project.join("agents") },
        profiles: Scoped { global: user_data_dir.join("profiles"), project: project.join("profiles") },
        skills: Scoped { global: user_data_dir.join("skills"), project: project.join("skills") },
    }
}

/// Home folder other tools keep user-level files in (overridable so tests never read a real home).
fn native_home_dir() -> PathBuf {
    std::env::var("PRAXIS_NATIVE_SOURCES_HOME")
        .ok()
        .filter(|home| !home.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// Where to look for other AI tools' files. With no working folder there is no project (never the
/// app's own cwd) and only the user-level files are discovered.
pub(super) fn native_source_options(host: &HostContext, working_directory: Option<&str>) -> NativeSourceOptions {
    let settings = host.settings().read();
    let config = &settings.ai.native_sources;
    let start = working_directory
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(str::to_owned)
        .or_else(|| Some(settings.ai.working_directory.trim().to_owned()).filter(|dir| !dir.is_empty()))
        .or_else(|| std::env::var("PRAXIS_AI_WORKING_DIR").ok().map(|dir| dir.trim().to_owned()).filter(|dir| !dir.is_empty()));
    let project_root = start.map(|dir| native_sources::find_project_root(Path::new(&dir)));
    let project_approved = project_root.as_ref().is_some_and(|root| config.approved_projects.iter().any(|approved| Path::new(approved) == root.as_path()));
    NativeSourceOptions {
        project_root,
        home_dir: native_home_dir(),
        enabled: config.ecosystems.clone(),
        project_approved,
        extra_skill_paths: config.extra_skill_paths.iter().map(PathBuf::from).collect(),
        extra_agent_paths: config.extra_agent_paths.iter().map(PathBuf::from).collect(),
    }
}

/// The project instructions a session on `runtime` in `working_directory` should carry.
pub(super) fn session_instructions(host: &HostContext, runtime: &str, working_directory: Option<&str>) -> Option<String> {
    let (inject, source) = {
        let settings = host.settings().read();
        (settings.ai.native_sources.inject_instructions, settings.ai.native_sources.instruction_source.clone())
    };
    if !inject {
        return None;
    }
    let options = native_source_options(host, working_directory);
    let found = native_sources::discover_native_sources(&options);
    let built = native_sources::build_session_instructions(&found.instructions, runtime, options.project_approved, &source);
    Some(built.text).filter(|text| !text.is_empty())
}

fn catalog_options(roots: &Roots) -> CatalogOptions {
    CatalogOptions {
        user_agents_path: Some(roots.hosts.global.clone()),
        project_agents_path: Some(roots.hosts.project.clone()),
        allow_project_agents: std::env::var("PRAXIS_ALLOW_PROJECT_AGENTS").as_deref() != Ok("0"),
        include_bundled: true,
        profile_roots: Some(vec![
            roots.profiles.global.clone(),
            roots.profiles.project.clone(),
            roots.hosts.global.clone(),
            roots.hosts.project.clone(),
        ]),
        trusted_profile_roots: Some(vec![roots.profiles.global.clone(), roots.hosts.global.clone()]),
        skill_roots: vec![roots.skills.global.clone(), roots.skills.project.clone()],
        trusted_skill_roots: Some(vec![roots.skills.global.clone()]),
        ..CatalogOptions::default()
    }
}

// ── host lifecycle state ─────────────────────────────────────────────────

/// A started runtime host. Dropping it stops the process.
struct HostEntry {
    child: Option<Child>,
    _stdin: Option<ChildStdin>,
    capabilities: Value,
}

impl Drop for HostEntry {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Default)]
struct RuntimeState {
    hosts: HashMap<String, HostEntry>,
    status: BTreeMap<String, Value>,
    skill_modes: HashMap<String, HashMap<String, String>>,
    snapshot: Option<Value>,
    mirrored: bool,
}

/// One state per profile directory, so concurrent test profiles never share hosts.
fn with_state<R>(user_data_dir: &Path, f: impl FnOnce(&mut RuntimeState) -> R) -> R {
    static STATES: OnceLock<Mutex<HashMap<PathBuf, RuntimeState>>> = OnceLock::new();
    let mut all = STATES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(all.entry(user_data_dir.to_path_buf()).or_default())
}

fn capabilities(streaming: bool) -> Value {
    json!({
        "supportsSkills": false, "supportsTools": false, "supportsMemory": false,
        "supportsResume": false, "supportsStreaming": streaming
    })
}

/// Starts only trusted manifests and never invokes a shell.
fn load_host(definition: &Value) -> std::result::Result<HostEntry, String> {
    let manifest = &definition["manifest"];
    let id = manifest["id"].as_str().unwrap_or_default();
    let has_errors = definition["errors"].as_array().is_some_and(|errors| !errors.is_empty());
    if definition["trusted"] != true || has_errors {
        return Err(format!("Agent {id} is not trusted or has manifest errors."));
    }
    let entry = &manifest["entry"];
    // Runs on the session's runtime: there is no process of its own to start.
    if definition["followsSessionRuntime"] == true || entry == "session" {
        return Ok(HostEntry { child: None, _stdin: None, capabilities: capabilities(true) });
    }
    if manifest["type"] == "http" {
        return Err("HTTP agent hosts cannot be started yet: the Rust runtime has no capability handshake.".into());
    }
    let (command, args): (String, Vec<String>) = match entry {
        Value::String(command) => (command.clone(), Vec::new()),
        Value::Object(object) => (
            object.get("command").and_then(Value::as_str).filter(|c| !c.is_empty()).ok_or("A subprocess host requires entry.command.")?.to_owned(),
            object.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default(),
        ),
        _ => return Err("A subprocess host requires entry.command.".into()),
    };
    let mut child = Command::new(&command)
        .args(&args)
        .current_dir(definition["rootPath"].as_str().unwrap_or("."))
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("spawn {command}: {error}"))?;
    let stdin = child.stdin.take();
    Ok(HostEntry { child: Some(child), _stdin: stdin, capabilities: capabilities(manifest["type"] == "gateway") })
}

fn running_status(entry: &HostEntry) -> Value {
    let mut status = json!({ "state": "running", "startedAt": super::now() });
    if let Some(pid) = entry.child.as_ref().map(Child::id) {
        status["pid"] = json!(pid);
    }
    status
}

// ── snapshot ─────────────────────────────────────────────────────────────

fn refresh(host: &HostContext, user_data_dir: &Path) -> Value {
    let roots = roots(host, user_data_dir);
    let mut options = catalog_options(&roots);
    options.native_sources = Some(native_source_options(host, None));
    let first = with_state(user_data_dir, |state| !std::mem::replace(&mut state.mirrored, true));
    if first {
        // Built-ins are mirrored on first use so users can see and edit them.
        bundled::mirror_bundled_agents(&roots.hosts.global);
        bundled::mirror_bundled_skills(&roots.skills.global);
    }
    let catalog = refresh_catalog(&options);
    with_state(user_data_dir, |state| {
        let mut snapshot = json!({
            "agents": catalog.hosts,
            "runtimeHosts": catalog.hosts,
            "profiles": catalog.profiles,
            "skills": catalog.skills,
            "capabilities": state.hosts.iter().map(|(id, entry)| (id.clone(), entry.capabilities.clone())).collect::<serde_json::Map<_, _>>(),
            "hosts": state.status,
            "refreshedAt": super::now()
        });
        if let Some(instructions) = catalog.instructions {
            snapshot["instructions"] = json!(instructions);
        }
        if let Some(project) = catalog.native_project {
            snapshot["nativeProject"] = project;
        }
        state.snapshot = Some(snapshot.clone());
        snapshot
    })
}

fn list(host: &HostContext, user_data_dir: &Path) -> Value {
    match with_state(user_data_dir, |state| state.snapshot.clone()) {
        Some(snapshot) => snapshot,
        None => refresh(host, user_data_dir),
    }
}

fn find_host(snapshot: &Value, id: &str) -> Result<Value> {
    snapshot["runtimeHosts"]
        .as_array()
        .and_then(|hosts| hosts.iter().find(|candidate| candidate["manifest"]["id"] == id))
        .cloned()
        .ok_or_else(|| failure(format!("Runtime host {id} was not discovered.")))
}

fn start(host: &HostContext, user_data_dir: &Path, id: &str) -> Result<Value> {
    let definition = find_host(&list(host, user_data_dir), id)?;
    with_state(user_data_dir, |state| state.hosts.remove(id));
    match load_host(&definition) {
        Ok(entry) => with_state(user_data_dir, |state| {
            state.status.insert(id.to_owned(), running_status(&entry));
            state.hosts.insert(id.to_owned(), entry);
        }),
        Err(message) => {
            with_state(user_data_dir, |state| {
                state.status.insert(id.to_owned(), json!({ "state": "failed", "startedAt": super::now(), "error": message }));
            });
            refresh(host, user_data_dir);
            return Err(failure(message));
        }
    }
    Ok(refresh(host, user_data_dir))
}

fn stop(host: &HostContext, user_data_dir: &Path, id: &str) -> Value {
    with_state(user_data_dir, |state| {
        state.hosts.remove(id);
        state.status.remove(id);
        state.skill_modes.remove(id);
    });
    refresh(host, user_data_dir)
}

fn activate_skill(host: &HostContext, user_data_dir: &Path, host_id: &str, skill_name: &str) -> Result<Value> {
    let snapshot = list(host, user_data_dir);
    let skill = snapshot["skills"]
        .as_array()
        .and_then(|skills| skills.iter().find(|candidate| candidate["metadata"]["name"] == skill_name))
        .cloned()
        .ok_or_else(|| failure(format!("Skill {skill_name} was not discovered.")))?;
    if let Some(error) = skill["error"].as_str() {
        return Err(failure(format!("Skill {skill_name} is invalid: {error}")));
    }
    let definition = find_host(&snapshot, host_id)?;
    if !with_state(user_data_dir, |state| state.hosts.contains_key(host_id)) {
        let entry = load_host(&definition).map_err(failure)?;
        with_state(user_data_dir, |state| {
            state.status.insert(host_id.to_owned(), running_status(&entry));
            state.hosts.insert(host_id.to_owned(), entry);
        });
    }
    let instructions = fs::read_to_string(skill["instructionsPath"].as_str().unwrap_or_default())
        .map_err(|error| failure(format!("Could not read skill {skill_name}: {error}")))?;
    let mode = with_state(user_data_dir, |state| {
        let supports_tools = state.hosts.get(host_id).is_some_and(|entry| entry.capabilities["supportsTools"] == true);
        // Native activation needs a host that accepts it; only HTTP hosts do, and they are not started yet.
        let mode = if supports_tools { "tools" } else { "context" };
        state.skill_modes.entry(host_id.to_owned()).or_default().insert(skill_name.to_owned(), mode.to_owned());
        mode
    });
    Ok(json!({ "agentId": host_id, "hostId": host_id, "skill": skill, "mode": mode, "instructions": instructions }))
}

// ── authoring and import ─────────────────────────────────────────────────

fn folder_names(root: &Path) -> Vec<String> {
    fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Re-checks every path against the target root, then writes without overwriting.
fn write_files(target: &Path, files: &[GeneratedFile]) -> Result<()> {
    let resolved: Vec<(PathBuf, &str)> = files
        .iter()
        .map(|file| authoring::safe_join(target, &file.path).map(|full| (full, file.content.as_str())).map_err(failure))
        .collect::<Result<_>>()?;
    for (full, content) in resolved {
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|error| failure(error.to_string()))?;
        }
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&full).map_err(|error| failure(format!("{}: {error}", full.display())))?;
        std::io::Write::write_all(&mut file, content.as_bytes()).map_err(|error| failure(error.to_string()))?;
    }
    Ok(())
}

fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target).map_err(|error| failure(error.to_string()))?;
    for entry in fs::read_dir(source).map_err(|error| failure(error.to_string()))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name != ".gitkeep" {
            continue;
        }
        let to = authoring::safe_join(target, &name).map_err(failure)?;
        let kind = entry.file_type().map_err(|error| failure(error.to_string()))?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else if kind.is_file() {
            let bytes = fs::read(entry.path()).map_err(|error| failure(error.to_string()))?;
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&to).map_err(|error| failure(format!("{}: {error}", to.display())))?;
            std::io::Write::write_all(&mut file, &bytes).map_err(|error| failure(error.to_string()))?;
        }
    }
    Ok(())
}

fn input<T: serde::de::DeserializeOwned>(args: &[Value]) -> Result<T> {
    serde_json::from_value(args.first().cloned().unwrap_or(Value::Null)).map_err(|error| failure(format!("Invalid input: {error}")))
}

fn create(host: &HostContext, user_data_dir: &Path, root: &Path, plan: CreationPlan) -> Result<Value> {
    if !plan.errors.is_empty() {
        return Err(failure(plan.errors.join("; ")));
    }
    write_files(&authoring::safe_join(root, &plan.folder).map_err(failure)?, &plan.files)?;
    Ok(refresh(host, user_data_dir))
}

fn read_import_source(kind: &str, source: &Path) -> std::result::Result<String, String> {
    let (file, label) = match kind {
        "agent" => ("agent.json", "agent.json"),
        "profile" => ("AGENT.md", "AGENT.md"),
        _ => ("SKILL.md", "SKILL.md"),
    };
    fs::read_to_string(source.join(file)).map_err(|_| format!("No readable {label} in the chosen folder."))
}

fn import_root<'a>(roots: &'a Roots, kind: &str, scope: &str) -> Result<&'a Path> {
    match kind {
        "agent" => roots.hosts.get(scope),
        "profile" => roots.profiles.get(scope),
        _ => roots.skills.get(scope),
    }
}

fn preview_import(roots: &Roots, kind: &str, source: &Path, scope: &str) -> Result<Value> {
    let existing = folder_names(import_root(roots, kind, scope)?);
    let fallback = || json!({ "kind": kind, "name": source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), "duplicate": false });
    let raw = match read_import_source(kind, source) {
        Ok(raw) => raw,
        Err(message) => {
            let mut preview = fallback();
            preview["errors"] = json!([message]);
            return Ok(preview);
        }
    };
    Ok(match kind {
        "agent" => match serde_json::from_str::<Value>(&raw) {
            Ok(manifest) => authoring::validate_agent_import(&manifest, &existing),
            Err(_) => {
                let mut preview = fallback();
                preview["errors"] = json!(["No readable agent.json in the chosen folder."]);
                preview
            }
        },
        "profile" => authoring::validate_agent_profile_import(&raw, &existing),
        _ => authoring::validate_skill_import(&raw, &existing),
    })
}

fn import_item(host: &HostContext, user_data_dir: &Path, args: &[Value]) -> Result<Value> {
    let (kind, source, scope, on_duplicate) = (text(args, 0)?, Path::new(text(args, 1)?), text(args, 2)?, text(args, 3).unwrap_or("block"));
    let roots = roots(host, user_data_dir);
    let preview = preview_import(&roots, kind, source, scope)?;
    let errors: Vec<&str> = preview["errors"].as_array().map(|e| e.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    if !errors.is_empty() {
        return Err(failure(errors.join("; ")));
    }
    let root = import_root(&roots, kind, scope)?;
    let folder = authoring::resolve_import_folder(preview["name"].as_str().unwrap_or_default(), &folder_names(root), on_duplicate).map_err(failure)?;
    copy_tree(source, &authoring::safe_join(root, &folder).map_err(failure)?)?;
    Ok(refresh(host, user_data_dir))
}

// ── bindings: an agent profile on a runtime host ─────────────────────────

/// A validated profile + host (+ skills) ready to launch (`AgentRuntimeManager.createBinding`).
pub(super) struct Binding {
    /// The discovered host definition (`manifest`, `rootPath`, `followsSessionRuntime`, ...).
    pub host: Value,
    /// `buildProfileContext`: the profile's instructions and the skills that carry theirs.
    pub context: String,
    /// `{ skillId, mode, version? }` per requested skill.
    pub skill_activations: Vec<Value>,
}

fn skill_read_natively(skill: &Value, provider: &str) -> bool {
    skill["source"]["readBy"].as_array().is_some_and(|read_by| read_by.iter().any(|runtime| runtime == provider))
}

/// Resolves and validates one binding immediately before launch: the host must be discovered,
/// trusted and error-free; the profile valid and trusted; every skill discovered and valid.
pub(super) fn create_binding(
    host: &HostContext,
    user_data_dir: &Path,
    profile_id: &str,
    host_id: &str,
    provider: &str,
    skill_names: &[String],
) -> Result<Binding> {
    let snapshot = list(host, user_data_dir);
    let definition = snapshot["runtimeHosts"]
        .as_array()
        .and_then(|hosts| hosts.iter().find(|candidate| candidate["manifest"]["id"] == host_id))
        .cloned()
        .ok_or_else(|| failure(format!("Runtime host \"{host_id}\" was not discovered.")))?;
    if definition["trusted"] != true {
        return Err(failure(format!("Runtime host \"{host_id}\" is not trusted.")));
    }
    if let Some(errors) = definition["errors"].as_array().filter(|errors| !errors.is_empty()) {
        let listed: Vec<String> = errors.iter().map(|error| format!("{}: {}", error["path"].as_str().unwrap_or_default(), error["message"].as_str().unwrap_or_default())).collect();
        return Err(failure(format!("Runtime host \"{host_id}\" has manifest errors: {}", listed.join("; "))));
    }
    let profile = snapshot["profiles"]
        .as_array()
        .and_then(|profiles| profiles.iter().find(|candidate| candidate["profile"]["id"] == profile_id))
        .cloned()
        .ok_or_else(|| failure(format!("Agent profile {profile_id} was not discovered.")))?;
    if let Some(error) = profile["error"].as_str() {
        return Err(failure(format!("Agent profile {profile_id} is invalid: {error}")));
    }
    if profile["trusted"] != true {
        return Err(failure(format!("Agent profile {profile_id} is not trusted.")));
    }

    let mut sections = vec![
        format!("## Praxis agent profile: {}", profile["profile"]["name"].as_str().unwrap_or_default()),
        profile["profile"]["instructions"].as_str().unwrap_or_default().to_owned(),
    ];
    let mut skill_activations = Vec::new();
    for name in skill_names {
        let skill = snapshot["skills"]
            .as_array()
            .and_then(|skills| skills.iter().find(|candidate| candidate["metadata"]["name"] == name.as_str()))
            .ok_or_else(|| failure(format!("Skill {name} was not discovered.")))?;
        if let Some(error) = skill["error"].as_str() {
            return Err(failure(format!("Skill {name} is invalid: {error}")));
        }
        let instructions = fs::read_to_string(skill["instructionsPath"].as_str().unwrap_or_default()).map_err(|error| failure(error.to_string()))?;
        // A skill from a tool's own folder is loaded by that tool's runtime itself, and a host
        // can confirm native activation; adding the instructions again would double them.
        let confirmed = with_state(user_data_dir, |state| state.skill_modes.get(host_id).and_then(|modes| modes.get(name)).cloned());
        let mode = if skill_read_natively(skill, provider) { "native".to_owned() } else { confirmed.unwrap_or_else(|| "context".to_owned()) };
        if mode != "native" {
            sections.push(format!("## Praxis skill: {name} ({mode})"));
            sections.push(instructions);
        }
        let mut activation = json!({ "skillId": name, "mode": mode });
        if let Some(version) = skill["metadata"]["version"].as_str().filter(|v| !v.is_empty()) {
            activation["version"] = json!(version);
        }
        skill_activations.push(activation);
    }
    let context = sections.into_iter().filter(|section| !section.is_empty()).collect::<Vec<_>>().join("\n\n");
    Ok(Binding { host: definition, context, skill_activations })
}

/// Paths discovery found: the only ones the renderer may ask to reveal.
fn discovered_paths(snapshot: &Value) -> Vec<String> {
    let strings = |value: &Value| value.as_str().map(str::to_owned);
    let mut paths = Vec::new();
    for profile in snapshot["profiles"].as_array().into_iter().flatten() {
        paths.extend(strings(&profile["source"]["path"]));
    }
    for skill in snapshot["skills"].as_array().into_iter().flatten() {
        if skill.get("source").is_some_and(|source| !source.is_null()) {
            paths.extend(strings(&skill["source"]["path"]));
            paths.extend(strings(&skill["instructionsPath"]));
        }
    }
    for file in snapshot["instructions"].as_array().into_iter().flatten() {
        paths.extend(strings(&file["path"]));
    }
    paths
}

fn reveal_native(host: &HostContext, user_data_dir: &Path, item_path: &str) -> Result<Value> {
    if !discovered_paths(&list(host, user_data_dir)).iter().any(|path| path == item_path) {
        return Err(failure("That file was not found by discovery."));
    }
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg("-R").arg(item_path).spawn();
    #[cfg(target_os = "windows")]
    let _ = Command::new("explorer").arg(format!("/select,\"{item_path}\"")).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = Command::new("xdg-open").arg(Path::new(item_path).parent().unwrap_or(Path::new(item_path))).spawn();
    Ok(Value::Null)
}

fn yaml_text(value: &str) -> String {
    let plain = value.chars().all(|c| c.is_alphanumeric() || c == '_' || matches!(c, ' ' | '.' | ',' | '(' | ')' | '&' | '\'' | '/' | '-'));
    if plain { value.to_owned() } else { serde_json::to_string(value).unwrap_or_default() }
}

/// Copies an agent or skill found in another tool's folder into Praxis's own global folder,
/// where it can be edited; Praxis's own items take precedence, so the copy replaces the original.
fn copy_native(host: &HostContext, user_data_dir: &Path, kind: &str, id: &str) -> Result<Value> {
    let snapshot = refresh(host, user_data_dir);
    let roots = roots(host, user_data_dir);
    let has_source = |entry: &Value| entry.get("source").is_some_and(|source| !source.is_null());
    if kind == "agent" {
        let entry = snapshot["profiles"]
            .as_array()
            .and_then(|profiles| profiles.iter().find(|entry| entry["profile"]["id"] == id && has_source(entry)))
            .ok_or_else(|| failure(format!("No agent \u{201c}{id}\u{201d} from another AI tool was found.")))?;
        if entry["trusted"] != true {
            return Err(failure("Approve this project\u{2019}s files before copying its agents."));
        }
        let target = roots.hosts.global.join(id);
        if target.exists() {
            return Err(failure(format!("Praxis already has an agent folder named \u{201c}{id}\u{201d}.")));
        }
        fs::create_dir_all(&target).map_err(|error| failure(error.to_string()))?;
        let profile = &entry["profile"];
        let name = profile["name"].as_str().unwrap_or_default();
        let mut lines = vec!["---".to_owned(), format!("id: {}", profile["id"].as_str().unwrap_or_default()), format!("name: {}", yaml_text(name))];
        if let Some(description) = profile["description"].as_str().filter(|d| !d.is_empty()) {
            lines.push(format!("description: {}", yaml_text(description)));
        }
        lines.push(format!("copiedFrom: {}", yaml_text(entry["source"]["path"].as_str().unwrap_or_default())));
        lines.extend(["---".to_owned(), String::new(), profile["instructions"].as_str().unwrap_or_default().trim().to_owned(), String::new()]);
        fs::write(target.join("AGENT.md"), lines.join("\n")).map_err(|error| failure(error.to_string()))?;
        // `entry: session` runs on the session's runtime, like the built-in agents.
        let manifest = json!({ "schemaVersion": 1, "id": profile["id"], "name": name, "type": "gateway", "entry": "session" });
        fs::write(target.join("agent.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default()).map_err(|error| failure(error.to_string()))?;
    } else {
        let skill = snapshot["skills"]
            .as_array()
            .and_then(|skills| skills.iter().find(|skill| skill["metadata"]["name"] == id && has_source(skill)))
            .ok_or_else(|| failure(format!("No skill \u{201c}{id}\u{201d} from another AI tool was found.")))?;
        if skill["trusted"] != true {
            return Err(failure("Approve this project\u{2019}s files before copying its skills."));
        }
        let target = roots.skills.global.join(id);
        if target.exists() {
            return Err(failure(format!("Praxis already has a skill folder named \u{201c}{id}\u{201d}.")));
        }
        copy_tree(Path::new(skill["skillPath"].as_str().unwrap_or_default()), &target)?;
    }
    Ok(refresh(host, user_data_dir))
}

pub fn dispatch(
    host: &HostContext,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "agentRuntime:roots" => {
            let discovered = roots(host, user_data_dir);
            // `native`/`user`/`projects` are the authoring roots; the rest is the discovery-path
            // shape Settings renders (`{ global, project }` each).
            Ok(json!({
                "native": user_data_dir.join("agent-runtime").join("native").to_string_lossy(),
                "user": user_data_dir.join("agent-runtime").join("user").to_string_lossy(),
                "projects": [],
                "agents": discovered.hosts.json(),
                "runtimeHosts": discovered.hosts.json(),
                "profiles": discovered.profiles.json(),
                "skills": discovered.skills.json()
            }))
        }
        "agentRuntime:list" => Ok(list(host, user_data_dir)),
        "agentRuntime:refresh" => Ok(refresh(host, user_data_dir)),
        "agentRuntime:start" => start(host, user_data_dir, text(args, 0)?),
        "agentRuntime:stop" => Ok(stop(host, user_data_dir, text(args, 0)?)),
        "agentRuntime:restart" => {
            let id = text(args, 0)?;
            stop(host, user_data_dir, id);
            start(host, user_data_dir, id)
        }
        "agentRuntime:activateSkill" => activate_skill(host, user_data_dir, text(args, 0)?, text(args, 1)?),
        "agentRuntime:createAgent" => {
            let request: NewAgentInput = input(args)?;
            let discovered = roots(host, user_data_dir);
            let root = discovered.hosts.get(&request.scope)?;
            create(host, user_data_dir, root, authoring::plan_new_agent(&request, &folder_names(root)))
        }
        "agentRuntime:createProfile" => {
            let request: NewAgentProfileInput = input(args)?;
            let discovered = roots(host, user_data_dir);
            let root = discovered.profiles.get(&request.scope)?;
            create(host, user_data_dir, root, authoring::plan_new_agent_profile(&request, &folder_names(root)))
        }
        "agentRuntime:createSkill" => {
            let request: NewSkillInput = input(args)?;
            let discovered = roots(host, user_data_dir);
            let root = discovered.skills.get(&request.scope)?;
            create(host, user_data_dir, root, authoring::plan_new_skill(&request, &folder_names(root)))
        }
        "agentRuntime:previewImport" => preview_import(&roots(host, user_data_dir), text(args, 0)?, Path::new(text(args, 1)?), text(args, 2)?),
        "agentRuntime:importItem" => import_item(host, user_data_dir, args),
        "agentRuntime:approveNativeProject" => {
            let project_root = text(args, 0)?;
            let approved = args.get(1).and_then(Value::as_bool) == Some(true);
            let mut next = host.settings().read().ai.native_sources.approved_projects.clone();
            next.retain(|root| root != project_root);
            if approved {
                next.push(project_root.to_owned());
            }
            super::ai_providers::write_settings(host, &json!({ "ai": { "nativeSources": { "approvedProjects": next } } }))?;
            Ok(refresh(host, user_data_dir))
        }
        "agentRuntime:revealNative" => reveal_native(host, user_data_dir, text(args, 0)?),
        "agentRuntime:copyNative" => copy_native(host, user_data_dir, text(args, 0)?, text(args, 1)?),
        _ => Err(failure(format!("Unknown agentRuntime channel: {channel}"))),
    }
}
