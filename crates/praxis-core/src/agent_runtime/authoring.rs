//! Pure builders for creating and importing agents, profiles and skills (FX-BF-010).
//!
//! Fail-closed and path-safe: a plan with any error carries no files, and every generated or
//! imported path is a single safe segment under the chosen scope root. Mirrors
//! `agentAuthoring.ts`; the application layer does the actual writes and re-checks each path.

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::catalog::{front_matter_block_pub, parse_agent_profile};
use super::front_matter_pair;
use super::manifest::validate_agent_manifest;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentInput {
    pub scope: String,
    pub name: String,
    pub id: String,
    pub transport: String,
    pub command: Option<String>,
    pub url: Option<String>,
    pub args: Option<Vec<String>>,
    pub config: Option<String>,
    pub activation: Option<String>,
    pub skills: Option<Vec<String>>,
    pub scaffold: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentProfileInput {
    pub scope: String,
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    pub preferred_skills: Option<Vec<String>>,
    pub instructions: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSkillInput {
    pub scope: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub triggers: Option<Vec<String>>,
    pub instructions: Option<String>,
    pub include_scripts: Option<bool>,
    pub include_references: Option<bool>,
    pub include_examples: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedFile {
    /// POSIX-style path relative to the new item's folder.
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Default)]
pub struct CreationPlan {
    pub folder: String,
    pub files: Vec<GeneratedFile>,
    /// Non-empty means nothing should be written.
    pub errors: Vec<String>,
}

fn blank(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(|text| text.trim().is_empty())
}

/// A lowercase, dash-safe single path segment (`^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`), or why not.
pub fn safe_segment(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("A name is required.".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("Only letters, digits, and dashes are allowed.".into());
    }
    let bytes = trimmed.as_bytes();
    let edge = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let valid = (2..=64).contains(&bytes.len())
        && edge(bytes[0])
        && edge(bytes[bytes.len() - 1])
        && bytes.iter().all(|&b| edge(b) || b == b'-');
    if valid {
        Ok(trimmed.to_owned())
    } else {
        Err("Use 2–64 lowercase letters, digits, or dashes (must start and end alphanumeric).".into())
    }
}

/// Joins `relative` under `root`, failing if it would escape.
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let escape = || format!("Path escapes the approved root: {relative}");
    let mut joined = super::resolve(root);
    let base = joined.clone();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => joined.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                joined.pop();
            }
            Component::RootDir | Component::Prefix(_) => return Err(escape()),
        }
    }
    if joined == base || !joined.starts_with(&base) {
        return Err(escape());
    }
    Ok(joined)
}

const PROCESS_TRANSPORTS: &[&str] = &["acp", "copilot-sdk", "custom"];
const NETWORK_TRANSPORTS: &[&str] = &["http", "gateway"];

/// Assembles and validates an `agent.json` body from wizard input.
#[must_use]
pub fn build_agent_manifest(input: &NewAgentInput) -> (Value, Vec<String>) {
    let mut errors = Vec::new();
    let mut entry = Map::new();
    if PROCESS_TRANSPORTS.contains(&input.transport.as_str()) {
        if blank(&input.command) {
            errors.push("A command is required for this transport.".to_owned());
        } else {
            entry.insert("command".into(), json!(input.command.as_deref().unwrap_or_default().trim()));
        }
        if let Some(args) = input.args.as_ref().filter(|args| !args.is_empty()) {
            let args: Vec<String> = args.iter().map(|arg| arg.trim().to_owned()).filter(|arg| !arg.is_empty()).collect();
            entry.insert("args".into(), json!(args));
        }
    } else if NETWORK_TRANSPORTS.contains(&input.transport.as_str()) {
        if blank(&input.url) {
            errors.push("A URL is required for this transport.".to_owned());
        } else {
            entry.insert("url".into(), json!(input.url.as_deref().unwrap_or_default().trim()));
        }
    }
    let mut manifest = Map::new();
    manifest.insert("schemaVersion".into(), json!(1));
    manifest.insert("id".into(), json!(input.id.trim()));
    manifest.insert("name".into(), json!(input.name.trim()));
    manifest.insert("type".into(), json!(input.transport));
    manifest.insert("entry".into(), Value::Object(entry));
    if let Some(skills) = input.skills.as_ref().filter(|skills| !skills.is_empty()) {
        manifest.insert("skills".into(), json!(skills));
    }
    if !blank(&input.config) {
        manifest.insert("config".into(), json!(input.config.as_deref().unwrap_or_default().trim()));
    }
    if let Some(activation) = &input.activation {
        manifest.insert("activation".into(), json!(activation));
    }
    let manifest = Value::Object(manifest);
    for issue in validate_agent_manifest(&manifest, &format!("{}/agent.json", input.id)) {
        errors.push(format!("{}: {}", issue["path"].as_str().unwrap_or_default(), issue["message"].as_str().unwrap_or_default()));
    }
    (manifest, errors)
}

fn pretty(value: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(value).unwrap_or_default())
}

fn agent_scaffold_files(input: &NewAgentInput) -> Vec<GeneratedFile> {
    if PROCESS_TRANSPORTS.contains(&input.transport.as_str()) {
        return vec![
            GeneratedFile {
                path: "index.js".into(),
                content: format!(
                    "// SCAFFOLD — this file is a starting point. Implement it before starting the host.\n\n/*\n * {name} — {transport} agent.\n * Speak your transport's protocol on stdio (or your chosen channel).\n */\n\nprocess.stderr.write('{id}: scaffold not implemented\\n');\nprocess.exit(1);\n",
                    name = input.name,
                    transport = input.transport,
                    id = input.id
                ),
            },
            GeneratedFile {
                path: "package.json".into(),
                content: pretty(&json!({ "name": input.id, "private": true, "type": "module", "scripts": { "start": "node index.js" } })),
            },
        ];
    }
    vec![GeneratedFile {
        path: "README.md".into(),
        content: format!(
            "# {name}\n\nScaffold for a **{transport}** agent. Point `entry.url` in `agent.json` at your\nrunning endpoint and remove this file once it is configured.\n\n- URL: `{url}`\n",
            name = input.name,
            transport = input.transport,
            url = input.url.as_deref().unwrap_or("(set me)")
        ),
    }]
}

/// Full plan for a new agent folder. Any error means no files.
#[must_use]
pub fn plan_new_agent(input: &NewAgentInput, existing_ids: &[String]) -> CreationPlan {
    let mut errors = Vec::new();
    let folder = safe_segment(&input.id);
    if let Err(error) = &folder {
        errors.push(format!("id: {error}"));
    }
    if input.name.trim().is_empty() {
        errors.push("name: A display name is required.".into());
    }
    if let Ok(name) = &folder
        && existing_ids.contains(name)
    {
        errors.push(format!("id: \"{name}\" already exists in this scope."));
    }
    let (manifest, built) = build_agent_manifest(input);
    errors.extend(built);
    if !errors.is_empty() {
        return CreationPlan { folder: folder.unwrap_or_default(), files: Vec::new(), errors };
    }
    let mut files = vec![GeneratedFile { path: "agent.json".into(), content: pretty(&manifest) }];
    if input.scaffold == Some(true) {
        files.extend(agent_scaffold_files(input));
    }
    CreationPlan { folder: folder.unwrap_or_default(), files, errors: Vec::new() }
}

/// The `SKILL.md` front matter and body for a new skill.
#[must_use]
pub fn build_skill_doc(input: &NewSkillInput) -> String {
    let mut lines = vec!["---".to_owned(), format!("name: {}", input.name.trim()), format!("description: {}", input.description.trim())];
    if let Some(version) = input.version.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        lines.push(format!("version: {version}"));
    }
    let triggers: Vec<&str> = input.triggers.iter().flatten().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
    if !triggers.is_empty() {
        lines.push(format!("triggers: {}", triggers.join(", ")));
    }
    lines.push("---".into());
    lines.push(String::new());
    let body = input.instructions.as_deref().map(str::trim).filter(|b| !b.is_empty()).map_or_else(
        || format!("# {}\n\nDescribe when and how to use this skill.", input.name.trim()),
        str::to_owned,
    );
    lines.push(body);
    format!("{}\n", lines.join("\n"))
}

/// Full plan for a new skill package. Any error means no files.
#[must_use]
pub fn plan_new_skill(input: &NewSkillInput, existing_names: &[String]) -> CreationPlan {
    let mut errors = Vec::new();
    let folder = safe_segment(&input.name);
    if let Err(error) = &folder {
        errors.push(format!("name: {error}"));
    }
    if input.description.trim().is_empty() {
        errors.push("description: A description is required.".into());
    }
    if let Ok(name) = &folder
        && existing_names.contains(name)
    {
        errors.push(format!("name: A skill named \"{name}\" already exists in this scope."));
    }
    if !errors.is_empty() {
        return CreationPlan { folder: folder.unwrap_or_default(), files: Vec::new(), errors };
    }
    let mut files = vec![GeneratedFile { path: "SKILL.md".into(), content: build_skill_doc(input) }];
    for (enabled, path, content) in [
        (input.include_scripts, "scripts/README.md", "# scripts\n\nExecutable helpers for this skill. Nothing here runs during discovery.\n"),
        (input.include_references, "references/README.md", "# references\n\nReference material the skill can cite.\n"),
        (input.include_examples, "examples/README.md", "# examples\n\nWorked examples of the skill in use.\n"),
    ] {
        if enabled == Some(true) {
            files.push(GeneratedFile { path: path.into(), content: content.into() });
        }
    }
    CreationPlan { folder: folder.unwrap_or_default(), files, errors: Vec::new() }
}

/// Canonical AGENT.md document for a provider-neutral role profile.
#[must_use]
pub fn build_agent_profile_doc(input: &NewAgentProfileInput) -> String {
    let mut lines = vec!["---".to_owned(), format!("id: {}", input.id.trim()), format!("name: {}", input.name.trim())];
    if let Some(description) = input.description.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        lines.push(format!("description: {description}"));
    }
    if let Some(version) = input.version.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        lines.push(format!("version: {version}"));
    }
    let skills: Vec<&str> = input.preferred_skills.iter().flatten().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if !skills.is_empty() {
        lines.push(format!("skills: {}", skills.join(", ")));
    }
    lines.extend(["---".to_owned(), String::new(), input.instructions.trim().to_owned(), String::new()]);
    lines.join("\n")
}

#[must_use]
pub fn plan_new_agent_profile(input: &NewAgentProfileInput, existing_ids: &[String]) -> CreationPlan {
    let mut errors = Vec::new();
    let folder = safe_segment(&input.id);
    if let Err(error) = &folder {
        errors.push(format!("id: {error}"));
    }
    if input.name.trim().is_empty() {
        errors.push("name: A display name is required.".into());
    }
    if input.instructions.trim().is_empty() {
        errors.push("instructions: Agent instructions are required.".into());
    }
    if let Ok(name) = &folder
        && existing_ids.contains(name)
    {
        errors.push(format!("id: \"{name}\" already exists in this scope."));
    }
    if !errors.is_empty() {
        return CreationPlan { folder: folder.unwrap_or_default(), files: Vec::new(), errors };
    }
    CreationPlan {
        folder: folder.unwrap_or_default(),
        files: vec![GeneratedFile { path: "AGENT.md".into(), content: build_agent_profile_doc(input) }],
        errors: Vec::new(),
    }
}

// ── Import validation ────────────────────────────────────────────────────

fn preview(kind: &str, name: String, duplicate: bool, errors: Vec<String>) -> Value {
    json!({ "kind": kind, "name": name, "duplicate": duplicate, "errors": errors })
}

/// Validates a would-be imported `agent.json`; `name` is the id to file it under.
#[must_use]
pub fn validate_agent_import(manifest: &Value, existing_ids: &[String]) -> Value {
    let mut errors: Vec<String> = validate_agent_manifest(manifest, "agent.json")
        .iter()
        .map(|issue| format!("{}: {}", issue["path"].as_str().unwrap_or_default(), issue["message"].as_str().unwrap_or_default()))
        .collect();
    let id = manifest["id"].as_str().map(str::trim).unwrap_or_default().to_owned();
    let safe = if id.is_empty() { Err("id: missing".to_owned()) } else { safe_segment(&id) };
    if let Err(error) = &safe
        && !errors.iter().any(|e| e.starts_with("id:"))
    {
        errors.push(format!("id: {error}"));
    }
    let duplicate = safe.as_ref().is_ok_and(|name| existing_ids.contains(name));
    preview("agent", safe.unwrap_or(id), duplicate, errors)
}

/// Validates a would-be imported AGENT.md profile.
#[must_use]
pub fn validate_agent_profile_import(markdown: &str, existing_ids: &[String]) -> Value {
    let (profile, error) = parse_agent_profile(markdown, "");
    let mut errors: Vec<String> = error.into_iter().collect();
    let id = profile["id"].as_str().unwrap_or_default().to_owned();
    let safe = if id.is_empty() { Err("id: missing".to_owned()) } else { safe_segment(&id) };
    if let Err(error) = &safe {
        errors.push(if error.starts_with("id") { error.clone() } else { format!("id: {error}") });
    }
    let duplicate = safe.as_ref().is_ok_and(|name| existing_ids.contains(name));
    preview("profile", safe.unwrap_or(id), duplicate, errors)
}

/// Minimal front-matter read for import validation: `(name, description, error)`.
#[must_use]
pub fn parse_skill_front_matter(content: &str) -> (Option<String>, Option<String>, Option<&'static str>) {
    if !content.starts_with("---") {
        return (None, None, Some("SKILL.md must start with YAML front matter."));
    }
    let Some(block) = front_matter_block_pub(content) else {
        return (None, None, Some("SKILL.md front matter is not closed."));
    };
    let strip = |value: &str| {
        let value = value.strip_prefix(['\'', '"']).unwrap_or(value);
        value.strip_suffix(['\'', '"']).unwrap_or(value).trim().to_owned()
    };
    let (mut name, mut description) = (None, None);
    for (key, value) in block.lines().filter_map(front_matter_pair) {
        match key {
            "name" => name = Some(strip(value)),
            "description" => description = Some(strip(value)),
            _ => {}
        }
    }
    let name = name.filter(|n| !n.is_empty());
    let description = description.filter(|d| !d.is_empty());
    if name.is_none() || description.is_none() {
        return (name, description, Some("name and description are required."));
    }
    (name, description, None)
}

/// Validates a would-be imported `SKILL.md`.
#[must_use]
pub fn validate_skill_import(markdown: &str, existing_names: &[String]) -> Value {
    let (name, _, error) = parse_skill_front_matter(markdown);
    let mut errors: Vec<String> = error.into_iter().map(str::to_owned).collect();
    let safe = match &name {
        Some(name) => safe_segment(name),
        None => Err("name: missing".to_owned()),
    };
    if let Err(error) = &safe {
        errors.push(if error.starts_with("name") { error.clone() } else { format!("name: {error}") });
    }
    let duplicate = safe.as_ref().is_ok_and(|n| existing_names.contains(n));
    preview("skill", safe.unwrap_or_else(|_| name.unwrap_or_default()), duplicate, errors)
}

/// A non-clashing folder name, deriving `-2`, `-3`… when `rename` is requested.
pub fn resolve_import_folder(base: &str, existing: &[String], on_duplicate: &str) -> Result<String, String> {
    let name = safe_segment(base)?;
    if !existing.contains(&name) {
        return Ok(name);
    }
    if on_duplicate == "block" {
        return Err(format!("\"{name}\" already exists — choose rename or a different source."));
    }
    (2..100)
        .map(|n| format!("{name}-{n}"))
        .find(|candidate| !existing.contains(candidate))
        .ok_or_else(|| "Could not find a free name.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str) -> NewAgentInput {
        NewAgentInput {
            scope: "global".into(),
            name: "Scaffolded Agent".into(),
            id: id.into(),
            transport: "acp".into(),
            command: Some("node".into()),
            url: None,
            args: Some(vec!["index.js".into()]),
            config: None,
            activation: None,
            skills: None,
            scaffold: Some(true),
        }
    }

    #[test]
    fn safe_segment_matches_the_wizard_rule() {
        assert_eq!(safe_segment("scaffolded-agent").as_deref(), Ok("scaffolded-agent"));
        for bad in ["Bad Id", "a", "-ab", "ab-", "a/b", "a..b", ""] {
            assert!(safe_segment(bad).is_err(), "{bad}");
        }
        assert!(safe_segment(&"a".repeat(65)).is_err());
    }

    #[test]
    fn safe_join_refuses_escapes() {
        let root = std::env::temp_dir().join("praxis-safe-join");
        assert!(safe_join(&root, "ok/file.md").is_ok());
        for bad in ["../x", "a/../../x", "/etc/passwd", ""] {
            assert!(safe_join(&root, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn new_agent_plan_matches_what_the_wizard_spec_expects() {
        let plan = plan_new_agent(&agent("scaffolded-agent"), &[]);
        assert!(plan.errors.is_empty(), "{:?}", plan.errors);
        assert_eq!(plan.folder, "scaffolded-agent");
        let manifest: Value = serde_json::from_str(&plan.files[0].content).expect("json");
        assert_eq!(manifest["entry"], json!({ "command": "node", "args": ["index.js"] }));
        assert_eq!(manifest["type"], "acp");
        assert!(plan.files.iter().any(|f| f.path == "index.js") && plan.files.iter().any(|f| f.path == "package.json"));
        assert!(plan.files[0].content.starts_with("{\n  \"schemaVersion\": 1,"), "key order is stable");
    }

    #[test]
    fn invalid_or_duplicate_agents_write_nothing() {
        let bad = plan_new_agent(&agent("Bad Id"), &[]);
        assert!(bad.files.is_empty() && !bad.errors.is_empty());
        let dup = plan_new_agent(&agent("scaffolded-agent"), &["scaffolded-agent".into()]);
        assert!(dup.files.is_empty() && dup.errors[0].contains("already exists"));
        let mut no_command = agent("x-agent");
        no_command.command = None;
        assert!(plan_new_agent(&no_command, &[]).errors.iter().any(|e| e.contains("A command is required")));
    }

    #[test]
    fn imports_reject_bad_manifests_and_flag_duplicates() {
        let bad = validate_agent_import(&json!({"schemaVersion":1,"id":"x","name":"X","type":"telepathy","entry":"run.js"}), &[]);
        assert!(!bad["errors"].as_array().expect("errors").is_empty());
        let good = validate_agent_import(&json!({"schemaVersion":1,"id":"imported-agent","name":"I","type":"acp","entry":"run.js"}), &["imported-agent".into()]);
        assert_eq!((good["errors"].as_array().map(Vec::len), good["duplicate"].as_bool()), (Some(0), Some(true)));
        let skill = validate_skill_import("---\nname: code-audit\ndescription: d\n---\nx", &[]);
        assert_eq!((skill["name"].as_str(), skill["errors"].as_array().map(Vec::len)), (Some("code-audit"), Some(0)));
        assert!(!validate_skill_import("no front matter", &[])["errors"].as_array().expect("e").is_empty());
    }

    #[test]
    fn resolve_import_folder_renames_or_blocks() {
        let existing = vec!["tool".to_owned(), "tool-2".to_owned()];
        assert_eq!(resolve_import_folder("tool", &existing, "rename").as_deref(), Ok("tool-3"));
        assert!(resolve_import_folder("tool", &existing, "block").is_err());
        assert_eq!(resolve_import_folder("fresh", &existing, "block").as_deref(), Ok("fresh"));
    }
}
