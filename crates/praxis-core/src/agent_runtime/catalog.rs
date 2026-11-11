//! Discovery of runtime hosts, agent profiles and skills, and the merged catalog snapshot.
//! Mirrors `discovery.ts`, `skillRegistry.ts`, `profileRegistry.ts` and the catalog half of
//! `AgentRuntimeManager.refresh()`. Other AI tools' folders (`nativeSources.ts`) are not
//! discovered yet.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::manifest::validate_agent_manifest;
use super::{bundled, directories, fingerprint, front_matter_pair, locale_cmp, resolve};

#[derive(Debug, Clone, Default)]
pub struct CatalogOptions {
    pub user_agents_path: Option<PathBuf>,
    pub project_agents_path: Option<PathBuf>,
    pub allow_project_agents: bool,
    pub explicit_agents_paths: Vec<PathBuf>,
    pub include_bundled: bool,
    pub profile_roots: Option<Vec<PathBuf>>,
    pub trusted_profile_roots: Option<Vec<PathBuf>>,
    pub skill_roots: Vec<PathBuf>,
    pub trusted_skill_roots: Option<Vec<PathBuf>>,
}

#[derive(Debug, Clone, Default)]
pub struct CatalogSnapshot {
    pub hosts: Vec<Value>,
    pub profiles: Vec<Value>,
    pub skills: Vec<Value>,
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

// ── runtime hosts (agent.json) ───────────────────────────────────────────

fn read_manifest(root_path: &Path, scope: &str, trusted_override: Option<bool>) -> Option<Value> {
    let manifest_path = root_path.join("agent.json");
    let parsed: Value = serde_json::from_str(&fs::read_to_string(&manifest_path).ok()?).ok()?;
    let errors = validate_agent_manifest(&parsed, &manifest_path.to_string_lossy());
    let trusted = trusted_override.unwrap_or(scope == "global" && errors.is_empty());
    Some(json!({
        "manifest": parsed,
        "manifestPath": manifest_path.to_string_lossy(),
        "rootPath": root_path.to_string_lossy(),
        "scope": scope,
        "trusted": trusted,
        "errors": errors
    }))
}

/// Reads manifests only; starting a host is deferred to the application layer.
#[must_use]
pub fn discover_agents(options: &CatalogOptions) -> Vec<Value> {
    let user_root = options.user_agents_path.as_deref().map(resolve);
    let mut roots: Vec<PathBuf> = Vec::new();
    roots.extend(options.user_agents_path.iter().cloned());
    if options.allow_project_agents {
        roots.extend(options.project_agents_path.iter().cloned());
    }
    roots.extend(options.explicit_agents_paths.iter().cloned());

    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    for root in roots.iter().map(|root| resolve(root)) {
        let scope = if Some(&root) == user_root.as_ref() { "global" } else { "project" };
        for agent_root in directories(&root) {
            let Some(found) = read_manifest(&agent_root, scope, None) else { continue };
            let id = found["manifest"]["id"].as_str().filter(|id| !id.is_empty()).map(str::to_owned);
            if let Some(id) = id
                && seen.insert(id)
            {
                result.push(found);
            }
        }
    }
    if options.include_bundled {
        for bundled in bundled::bundled_manifests() {
            if let Some(id) = bundled["manifest"]["id"].as_str()
                && seen.insert(id.to_owned())
            {
                result.push(bundled);
            }
        }
    }
    result.sort_by(|a, b| locale_cmp(str_of(&a["manifest"], "name"), str_of(&b["manifest"], "name")));
    result
}

// ── skills (SKILL.md) ────────────────────────────────────────────────────

/// A one-line YAML scalar: quotes removed and a double-quoted value's escapes decoded.
#[must_use]
pub fn yaml_scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len() - 1].replace("\\\"", "\""))
            .trim()
            .to_owned();
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return value[1..value.len() - 1].replace("''", "'").trim().to_owned();
    }
    value.to_owned()
}

struct ParsedSkill {
    metadata: Map<String, Value>,
    error: Option<&'static str>,
}

pub(crate) fn front_matter_block_pub(content: &str) -> Option<&str> {
    front_matter_block(content)
}

fn front_matter_block(content: &str) -> Option<&str> {
    let end = content[3..].find("\n---").map(|at| at + 3)?;
    Some(&content[3..end])
}

fn parse_skill(content: &str) -> ParsedSkill {
    let mut metadata = Map::new();
    metadata.insert("name".into(), json!(""));
    metadata.insert("description".into(), json!(""));
    metadata.insert("triggers".into(), json!([]));
    if !content.starts_with("---") {
        return ParsedSkill { metadata, error: Some("SKILL.md must start with YAML front matter.") };
    }
    let Some(block) = front_matter_block(content) else {
        return ParsedSkill { metadata, error: Some("SKILL.md front matter is not closed.") };
    };
    let values: std::collections::HashMap<&str, String> =
        block.lines().filter_map(front_matter_pair).map(|(key, value)| (key, yaml_scalar(value))).collect();
    let name = values.get("name").cloned().unwrap_or_default();
    let description = values.get("description").cloned().unwrap_or_default();
    let triggers: Vec<String> = values
        .get("triggers")
        .map(|raw| raw.split(',').map(|item| item.trim().to_owned()).filter(|item| !item.is_empty()).collect())
        .unwrap_or_default();
    metadata.insert("name".into(), json!(name));
    metadata.insert("description".into(), json!(description));
    metadata.insert("triggers".into(), json!(triggers));
    if name.is_empty() || description.is_empty() {
        return ParsedSkill { metadata, error: Some("name and description are required.") };
    }
    if let Some(version) = values.get("version") {
        metadata.insert("version".into(), json!(version));
    }
    if let Some(title) = values.get("title").filter(|title| !title.is_empty()) {
        metadata.insert("title".into(), json!(title));
    }
    ParsedSkill { metadata, error: None }
}

/// Indexes metadata and fingerprints without loading instruction bodies or resources.
#[must_use]
pub fn discover_skills(roots: &[PathBuf], trusted_roots: &[PathBuf]) -> Vec<Value> {
    let trusted: Vec<PathBuf> = trusted_roots.iter().map(|root| resolve(root)).collect();
    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    for root in roots.iter().map(|root| resolve(root)) {
        let root_is_trusted = trusted.contains(&root);
        for skill_path in directories(&root) {
            let instructions_path = skill_path.join("SKILL.md");
            let Ok(content) = fs::read_to_string(&instructions_path) else { continue };
            let mut parsed = parse_skill(&content);
            let folder = skill_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let name = match parsed.metadata.get("name").and_then(Value::as_str) {
                Some(name) if !name.is_empty() => name.to_owned(),
                _ => folder,
            };
            if !seen.insert(name.clone()) {
                continue;
            }
            parsed.metadata.insert("name".into(), json!(name));
            let resolved = resolve(&skill_path);
            let skill_trusted = trusted.iter().any(|trusted_root| resolved.starts_with(trusted_root) && resolved != *trusted_root);
            let mut entry = json!({
                "metadata": Value::Object(parsed.metadata),
                "skillPath": skill_path.to_string_lossy(),
                "instructionsPath": instructions_path.to_string_lossy(),
                "fingerprint": fingerprint(&content),
                "scope": if root_is_trusted { "global" } else { "project" },
                "trusted": skill_trusted
            });
            if let Some(error) = parsed.error {
                entry["error"] = json!(error);
            }
            result.push(entry);
        }
    }
    result.sort_by(|a, b| locale_cmp(str_of(&a["metadata"], "name"), str_of(&b["metadata"], "name")));
    result
}

// ── profiles (AGENT.md) ──────────────────────────────────────────────────

fn strip_quotes(value: &str) -> String {
    let value = value.strip_prefix(['\'', '"']).unwrap_or(value);
    value.strip_suffix(['\'', '"']).unwrap_or(value).trim().to_owned()
}

/// `(id, profile, error)` for an AGENT.md document.
#[must_use]
pub fn parse_agent_profile(content: &str, fallback_id: &str) -> (Value, Option<String>) {
    let (values, body, error): (std::collections::HashMap<&str, String>, String, Option<String>) = if content.starts_with("---") {
        match front_matter_block(content) {
            None => (Default::default(), String::new(), Some("AGENT.md front matter is not closed.".into())),
            Some(block) => {
                let end = content[3..].find("\n---").map_or(content.len(), |at| at + 3);
                let body = content.get(end + 4..).unwrap_or_default().trim().to_owned();
                (block.lines().filter_map(front_matter_pair).map(|(key, value)| (key, strip_quotes(value))).collect(), body, None)
            }
        }
    } else {
        (Default::default(), content.trim().to_owned(), None)
    };
    let pick = |key: &str| values.get(key).filter(|value| !value.is_empty()).cloned();
    let id = pick("id").unwrap_or_else(|| fallback_id.to_owned());
    let name = pick("name").unwrap_or_else(|| id.clone());
    let preferred: Vec<String> = values
        .get("skills")
        .map(|raw| raw.split(',').map(|item| item.trim().to_owned()).filter(|item| !item.is_empty()).collect())
        .unwrap_or_default();
    let mut profile = json!({ "id": id, "name": name, "instructions": body });
    if let Some(description) = pick("description") {
        profile["description"] = json!(description);
    }
    if let Some(version) = pick("version") {
        profile["version"] = json!(version);
    }
    if !preferred.is_empty() {
        profile["preferredSkills"] = json!(preferred);
    }
    if error.is_some() {
        return (profile, error);
    }
    if id.trim().is_empty() || name.trim().is_empty() || body.is_empty() {
        return (profile, Some("Agent profile requires an id, name and instruction body.".into()));
    }
    (profile, None)
}

fn read_profile(root_path: &Path, scope: &str, trusted: bool) -> Option<Value> {
    let canonical = root_path.join("AGENT.md");
    let (profile_path, legacy, content) = match fs::read_to_string(&canonical) {
        Ok(content) => (canonical, false, content),
        Err(_) => {
            let legacy = root_path.join("brief.md");
            (legacy.clone(), true, fs::read_to_string(&legacy).ok()?)
        }
    };
    let folder = root_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (profile, error) = parse_agent_profile(&content, &folder);
    let mut entry = json!({
        "profile": profile,
        "profilePath": profile_path.to_string_lossy(),
        "rootPath": root_path.to_string_lossy(),
        "fingerprint": fingerprint(&content),
        "scope": scope,
        "trusted": trusted,
        "legacy": legacy
    });
    if let Some(error) = error {
        entry["error"] = json!(error);
    }
    Some(entry)
}

/// Canonical AGENT.md profiles and legacy brief.md profiles, plus the built-ins when asked.
#[must_use]
pub fn discover_agent_profiles(roots: &[PathBuf], trusted_roots: &[PathBuf], include_bundled: bool) -> Vec<Value> {
    let trusted: Vec<PathBuf> = trusted_roots.iter().map(|root| resolve(root)).collect();
    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    for root in roots.iter().map(|root| resolve(root)) {
        let root_trusted = trusted.contains(&root);
        for profile_root in directories(&root) {
            let Some(found) = read_profile(&profile_root, if root_trusted { "global" } else { "project" }, root_trusted) else { continue };
            if seen.insert(str_of(&found["profile"], "id").to_owned()) {
                result.push(found);
            }
        }
    }
    if include_bundled {
        for (id, definition) in bundled::bundled_agent_definitions() {
            if !seen.insert(id.clone()) {
                continue;
            }
            let brief = str_of(&definition, "brief").to_owned();
            let mut profile = json!({ "id": id, "name": definition["manifest"]["name"], "instructions": brief });
            if let Some(skills) = definition["skills"].as_array().filter(|skills| !skills.is_empty()) {
                profile["preferredSkills"] = json!(skills);
            }
            result.push(json!({
                "profile": profile,
                "profilePath": format!("/bundled/{id}/AGENT.md"),
                "rootPath": format!("/bundled/{id}"),
                "fingerprint": fingerprint(&brief),
                "scope": "global",
                "trusted": true,
                "legacy": false
            }));
        }
    }
    result.sort_by(|a, b| locale_cmp(str_of(&a["profile"], "name"), str_of(&b["profile"], "name")));
    result
}

/// The catalog half of `AgentRuntimeManager.refresh()`.
#[must_use]
pub fn refresh_catalog(options: &CatalogOptions) -> CatalogSnapshot {
    let default_profile_roots: Vec<PathBuf> = options
        .user_agents_path
        .iter()
        .cloned()
        .chain(options.allow_project_agents.then(|| options.project_agents_path.clone()).flatten())
        .collect();
    let profile_roots = options.profile_roots.clone().unwrap_or(default_profile_roots.clone());
    let trusted_profile_roots = options.trusted_profile_roots.clone().unwrap_or_else(|| {
        if options.user_agents_path.is_some() { options.user_agents_path.iter().cloned().collect() } else { profile_roots.clone() }
    });
    let trusted_skill_roots = options.trusted_skill_roots.clone().unwrap_or_else(|| options.skill_roots.clone());

    let hosts = discover_agents(options);
    let profiles = discover_agent_profiles(&profile_roots, &trusted_profile_roots, options.include_bundled);
    let skills = discover_skills(&options.skill_roots, &trusted_skill_roots);

    // Built-in agents written before descriptions existed keep their AGENT.md, so the list
    // description comes from the bundle.
    let mut aligned: Vec<Value> = profiles
        .into_iter()
        .map(|mut entry| {
            let id = str_of(&entry["profile"], "id").to_owned();
            if bundled::is_bundled_agent(&id) {
                entry["builtIn"] = json!(true);
            }
            let description = entry["profile"]["description"].as_str().map(str::to_owned).or_else(|| bundled::bundled_agent_description(&id));
            if let Some(description) = description {
                entry["profile"]["description"] = json!(description);
            }
            entry
        })
        .collect();
    // Same for skills installed before titles existed.
    let skills: Vec<Value> = skills
        .into_iter()
        .map(|mut skill| {
            if let Some(known) = bundled::bundled_skill(str_of(&skill["metadata"], "name")) {
                skill["builtIn"] = json!(true);
                if skill["metadata"]["title"].is_null() {
                    skill["metadata"]["title"] = known["title"].clone();
                }
            }
            skill
        })
        .collect();
    // A launch binding without a profile of its own still gets one, so it is listed.
    for host in &hosts {
        let id = str_of(&host["manifest"], "id");
        if aligned.iter().any(|profile| str_of(&profile["profile"], "id") == id) {
            continue;
        }
        let name = str_of(&host["manifest"], "name");
        aligned.push(json!({
            "profile": {
                "id": id,
                "name": name,
                "instructions": format!("Use the {name} runtime to complete the supplied task.")
            },
            "profilePath": host["manifestPath"],
            "rootPath": host["rootPath"],
            "fingerprint": "legacy-host-profile",
            "scope": host["scope"],
            "trusted": host["trusted"],
            "legacy": true
        }));
    }
    CatalogSnapshot { hosts, profiles: aligned, skills }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(path, content).expect("write");
    }

    /// The fixture `agentHub.spec.ts` seeds.
    fn seeded(tag: &str) -> (PathBuf, CatalogOptions) {
        let dir = std::env::temp_dir().join(format!("praxis-catalog-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write(&dir.join("agents/praxis-reviewer/agent.json"), r#"{"schemaVersion":1,"id":"praxis-reviewer","name":"Praxis Reviewer","type":"acp","entry":{"command":"node","args":["review.js"]},"activation":"onDemand"}"#);
        write(&dir.join("agents/broken-agent/agent.json"), r#"{"schemaVersion":1,"id":"broken-agent","name":"Broken Agent","type":"telepathy","entry":"run.js"}"#);
        write(&dir.join("skills/code-audit/SKILL.md"), "---\nname: code-audit\ndescription: Audits a diff for risky changes.\ntriggers: review, audit\n---\nInstructions.");
        let options = CatalogOptions {
            user_agents_path: Some(dir.join("agents")),
            project_agents_path: Some(dir.join("project/.praxis/agents")),
            allow_project_agents: true,
            include_bundled: true,
            profile_roots: Some(vec![dir.join("profiles"), dir.join("project/.praxis/profiles"), dir.join("agents"), dir.join("project/.praxis/agents")]),
            trusted_profile_roots: Some(vec![dir.join("profiles"), dir.join("agents")]),
            skill_roots: vec![dir.join("skills"), dir.join("project/.praxis/skills")],
            trusted_skill_roots: Some(vec![dir.join("skills")]),
            ..CatalogOptions::default()
        };
        (dir, options)
    }

    #[test]
    fn discovers_seeded_hosts_skills_and_bundled_profiles() {
        let (dir, options) = seeded("seed");
        let snapshot = refresh_catalog(&options);

        let broken = snapshot.hosts.iter().find(|h| h["manifest"]["id"] == "broken-agent").expect("broken listed");
        assert_eq!(broken["trusted"], false, "a manifest with errors is never trusted");
        assert_eq!(broken["errors"][0]["message"], "Unsupported transport: telepathy");

        let reviewer = snapshot.profiles.iter().find(|p| p["profile"]["id"] == "praxis-reviewer").expect("reviewer profile");
        assert_eq!(reviewer["legacy"], false, "the bundled profile for this id already exists, so none is synthesized");
        assert_eq!(reviewer["builtIn"], true, "praxis-reviewer is also a bundled agent id");
        let live_dir_profile = snapshot.profiles.iter().find(|p| p["profile"]["id"] == "broken-agent").expect("profile for a host with none");
        assert_eq!(live_dir_profile["legacy"], true, "a host with no profile of its own gets a synthesized one");
        assert!(snapshot.profiles.iter().any(|p| p["profile"]["id"] == "praxis-scheduler" && p["builtIn"] == true));

        let skill = snapshot.skills.iter().find(|s| s["metadata"]["name"] == "code-audit").expect("skill");
        assert_eq!(skill["metadata"]["description"], "Audits a diff for risky changes.");
        assert_eq!(skill["metadata"]["triggers"], json!(["review", "audit"]));
        assert_eq!(skill["trusted"], true);
        assert!(skill.get("error").is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn project_skills_are_untrusted_and_bad_skills_carry_an_error() {
        let (dir, options) = seeded("proj");
        write(&dir.join("project/.praxis/skills/project-only/SKILL.md"), "---\nname: project-only\ndescription: Only here.\n---\nx");
        write(&dir.join("skills/no-frontmatter/SKILL.md"), "just text");
        let snapshot = refresh_catalog(&options);
        let project = snapshot.skills.iter().find(|s| s["metadata"]["name"] == "project-only").expect("project skill");
        assert_eq!((project["scope"].as_str(), project["trusted"].as_bool()), (Some("project"), Some(false)));
        let bad = snapshot.skills.iter().find(|s| s["metadata"]["name"] == "no-frontmatter").expect("bad skill listed");
        assert_eq!(bad["error"], "SKILL.md must start with YAML front matter.");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn yaml_scalars_and_agent_profiles_parse_like_the_typescript() {
        assert_eq!(yaml_scalar(r#""Say \"hi\"\nnow""#), "Say \"hi\"\nnow");
        assert_eq!(yaml_scalar("'it''s'"), "it's");
        assert_eq!(yaml_scalar("  plain  "), "plain");
        let (profile, error) = parse_agent_profile("---\nid: a\nname: 'A Agent'\nskills: x, y\n---\nDo it.", "fallback");
        assert!(error.is_none());
        assert_eq!(profile["name"], "A Agent");
        assert_eq!(profile["preferredSkills"], json!(["x", "y"]));
        assert_eq!(parse_agent_profile("---\nid: a\n", "f").1.as_deref(), Some("AGENT.md front matter is not closed."));
        assert_eq!(parse_agent_profile("   ", "f").1.as_deref(), Some("Agent profile requires an id, name and instruction body."));
    }
}
