//! Agents and skills that ship with Praxis. The definitions are generated from the
//! TypeScript source by `scripts/generate-bundled-agents.mjs` into `bundled.json`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{Map, Value, json};

fn data() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("bundled.json")).unwrap_or_else(|_| json!({}))
    })
}

fn section(name: &str) -> Map<String, Value> {
    data()[name].as_object().cloned().unwrap_or_default()
}

/// Agents mirrored into the user's agents folder and listed as built-in profiles.
#[must_use]
pub fn bundled_agent_definitions() -> Map<String, Value> {
    section("bundledAgents")
}

/// True for agents shipped with Praxis.
#[must_use]
pub fn is_bundled_agent(id: &str) -> bool {
    data()["availableAgents"].get(id).is_some()
}

/// The built-in skill definition for `name`, if Praxis ships one.
#[must_use]
pub fn bundled_skill(name: &str) -> Option<&'static Value> {
    data()["availableSkills"].get(name)
}

/// The description a built-in agent shows when its AGENT.md predates descriptions.
#[must_use]
pub fn bundled_agent_description(id: &str) -> Option<String> {
    data()["availableAgents"][id]["description"]
        .as_str()
        .map(str::to_owned)
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

/// The `AGENT.md` written for a bundled agent.
#[must_use]
pub fn profile_doc(definition: &Value) -> String {
    let manifest = &definition["manifest"];
    let skills: Vec<&str> = definition["skills"]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut lines = vec![
        "---".to_owned(),
        format!("id: {}", text(manifest, "id")),
        format!("name: {}", text(manifest, "name")),
        format!("description: {}", text(definition, "description")),
    ];
    if !skills.is_empty() {
        lines.push(format!("skills: {}", skills.join(", ")));
    }
    lines.extend([
        "version: 1.0.0".to_owned(),
        "---".to_owned(),
        String::new(),
        text(definition, "brief").trim().to_owned(),
        String::new(),
    ]);
    lines.join("\n")
}

/// Synthetic discovered hosts for every bundled agent (trusted, scope `global`).
#[must_use]
pub fn bundled_manifests() -> Vec<Value> {
    bundled_agent_definitions()
        .values()
        .map(|definition| {
            let id = text(&definition["manifest"], "id");
            json!({
                "manifest": definition["manifest"],
                "manifestPath": format!("/bundled/{id}/agent.json"),
                "rootPath": format!("/bundled/{id}"),
                "scope": "global",
                "trusted": true,
                "errors": []
            })
        })
        .collect()
}

/// `version: x` from a document's front matter.
fn doc_version(doc: &str) -> Option<String> {
    doc.lines()
        .find_map(|line| line.strip_prefix("version:").map(|rest| rest.trim_start()))
        .and_then(|rest| rest.split_whitespace().next())
        .map(str::to_owned)
}

fn write_text(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)
}

/// Installs an available agent definition under `target/<id>`. False when unknown.
pub fn install_available_agent(agent_id: &str, target_agents_dir: &Path) -> bool {
    let Some(definition) = data()["availableAgents"].get(agent_id) else {
        return false;
    };
    let dir = target_agents_dir.join(agent_id);
    let manifest = serde_json::to_string_pretty(&definition["manifest"]).unwrap_or_default();
    write_text(&dir.join("agent.json"), &manifest).is_ok()
        && write_text(&dir.join("AGENT.md"), &profile_doc(definition)).is_ok()
}

/// Installs an available skill under `target/<name>/SKILL.md`. False when unknown.
pub fn install_available_skill(skill_name: &str, target_skills_dir: &Path) -> bool {
    let Some(definition) = bundled_skill(skill_name) else {
        return false;
    };
    write_text(
        &target_skills_dir.join(skill_name).join("SKILL.md"),
        &text(definition, "instructions"),
    )
    .is_ok()
}

/// Writes the always-on bundled skills. A missing skill is written, an older one replaced, and
/// one at the current version left alone so user edits survive until Praxis ships a new version.
pub fn mirror_bundled_skills(target_skills_dir: &Path) -> Vec<String> {
    let mut mirrored = Vec::new();
    for name in data()["bundledSkillNames"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let Some(definition) = bundled_skill(name) else {
            continue;
        };
        let instructions = text(definition, "instructions");
        let file: PathBuf = target_skills_dir.join(name).join("SKILL.md");
        let current = fs::read_to_string(&file).ok();
        if current
            .as_deref()
            .is_some_and(|existing| doc_version(existing) == doc_version(&instructions))
            || write_text(&file, &instructions).is_ok()
        {
            mirrored.push(name.to_owned());
        }
    }
    mirrored
}

/// Mirrors bundled agent manifests and profiles into the trusted discovery root. The manifest is
/// rewritten only when its id or type differ; an existing `AGENT.md` is never overwritten.
pub fn mirror_bundled_agents(target_dir: &Path) -> Vec<String> {
    let mut mirrored = Vec::new();
    let _ = fs::create_dir_all(target_dir);
    for (id, definition) in bundled_agent_definitions() {
        let dir = target_dir.join(&id);
        if fs::create_dir_all(&dir).is_err() {
            continue;
        }
        let manifest_file = dir.join("agent.json");
        let up_to_date = fs::read_to_string(&manifest_file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .is_some_and(|parsed| {
                parsed["id"] == json!(id) && parsed["type"] == definition["manifest"]["type"]
            });
        if !up_to_date {
            let body = serde_json::to_string_pretty(&definition["manifest"]).unwrap_or_default();
            if write_text(&manifest_file, &body).is_err() {
                continue;
            }
        }
        let profile = dir.join("AGENT.md");
        if !profile.exists() {
            let _ = write_text(&profile, &profile_doc(&definition));
        }
        mirrored.push(id);
    }
    mirrored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ships_the_scheduler_agent_with_its_skill() {
        let agents = bundled_agent_definitions();
        let scheduler = &agents["praxis-scheduler"];
        assert_eq!(scheduler["manifest"]["name"], "Praxis Scheduler");
        assert!(
            scheduler["skills"]
                .as_array()
                .is_some_and(|s| s.contains(&json!("praxis-scheduled-runs")))
        );
        assert_eq!(
            bundled_skill("praxis-scheduled-runs").map(|s| s["title"].clone()),
            Some(json!("Scheduled Run Authoring"))
        );
        assert!(is_bundled_agent("praxis-reviewer") && !is_bundled_agent("nope"));
    }

    #[test]
    fn mirroring_is_idempotent_and_preserves_user_edits() {
        let dir = std::env::temp_dir().join(format!("praxis-mirror-{}", std::process::id()));
        let skills = dir.join("skills");
        let agents = dir.join("agents");
        assert_eq!(
            mirror_bundled_skills(&skills),
            vec!["praxis-scheduled-runs"]
        );
        let skill_file = skills.join("praxis-scheduled-runs/SKILL.md");
        let original = fs::read_to_string(&skill_file).expect("skill written");
        let edited = format!("{original}\nUSER EDIT\n");
        fs::write(&skill_file, &edited).expect("edit");
        mirror_bundled_skills(&skills);
        assert_eq!(
            fs::read_to_string(&skill_file).expect("read"),
            edited,
            "same version is left alone"
        );

        assert_eq!(
            mirror_bundled_agents(&agents).len(),
            bundled_agent_definitions().len()
        );
        let profile = agents.join("praxis-planner/AGENT.md");
        fs::write(&profile, "mine").expect("edit profile");
        mirror_bundled_agents(&agents);
        assert_eq!(fs::read_to_string(&profile).expect("read"), "mine");
        let _ = fs::remove_dir_all(dir);
    }
}
