//! Workflow packs: `.github/skills/<name>/SKILL.md` discovery and per-issue assignment
//! (`agentWorkflowCatalog.ts` `discoverWorkspaceAgentWorkflows` + the session manager's
//! `workflowAssignments`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use praxis_host::HostContext;
use serde_json::{Value, json};

use super::storage::{self, PROJECTS};

fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n")
}

fn strip_markdown(value: &str) -> String {
    value.chars().filter(|c| !matches!(c, '`' | '*' | '_' | '>' | '#')).collect::<String>().trim().to_string()
}

fn frontmatter(text: &str) -> Option<String> {
    let text = normalize(text);
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    Some(rest[..end].to_string())
}

fn frontmatter_value(front: Option<&str>, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    front?
        .lines()
        .find_map(|line| line.strip_prefix(prefix.as_str()))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn heading(text: &str) -> Option<String> {
    normalize(text)
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(strip_markdown))
        .filter(|h| !h.is_empty())
}

fn first_paragraph(text: &str) -> Option<String> {
    let text = normalize(text);
    let body = match text.strip_prefix("---\n").and_then(|rest| rest.find("\n---").map(|i| &rest[i + 4..])) {
        Some(rest) => rest.trim_start_matches('\n').to_string(),
        None => text.clone(),
    };
    let mut paragraph: Vec<String> = Vec::new();
    let mut seen_heading = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if trimmed.starts_with('#') {
            seen_heading = true;
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if seen_heading || !paragraph.is_empty() {
            paragraph.push(strip_markdown(trimmed));
        }
    }
    let joined = paragraph.join(" ").trim().to_string();
    (!joined.is_empty()).then_some(joined)
}

fn title_from_slug(value: &str) -> String {
    value
        .split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut chars = p.chars();
            chars.next().map_or(String::new(), |c| c.to_uppercase().collect::<String>() + chars.as_str())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn pack_at(root: &Path, dir: &Path) -> Option<Value> {
    let file = if dir.is_dir() { dir.join("SKILL.md") } else { dir.to_path_buf() };
    let markdown = std::fs::read_to_string(&file).ok()?;
    let front = frontmatter(&markdown);
    let fallback = file.parent()?.file_name()?.to_string_lossy().into_owned();
    let id = frontmatter_value(front.as_deref(), "name").unwrap_or(fallback);
    let name = heading(&markdown).unwrap_or_else(|| title_from_slug(&id));
    let description = frontmatter_value(front.as_deref(), "description").or_else(|| first_paragraph(&markdown));
    let version = frontmatter_value(front.as_deref(), "version");
    let stored = match file.strip_prefix(root) {
        Ok(relative) if !relative.as_os_str().is_empty() => relative.to_string_lossy().replace('\\', "/"),
        _ => file.to_string_lossy().into_owned(),
    };
    let mut pack = json!({ "id": id, "name": name, "instructionsPath": stored });
    if let Some(description) = description {
        pack["description"] = json!(description);
    }
    if let Some(version) = version {
        pack["version"] = json!(version);
    }
    Some(pack)
}

/// Every pack under `<root>/.github/skills`, sorted by name.
pub fn discover(root: Option<&Path>) -> Vec<Value> {
    let Some(root) = root else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(root.join(".github").join("skills")) else {
        return Vec::new();
    };
    let mut packs: Vec<Value> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|e| pack_at(root, &e.path()))
        .collect();
    packs.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    packs
}

/// The folder packs are discovered in: the configured working directory, else the first project's.
pub fn discovery_root(host: &HostContext) -> Option<PathBuf> {
    let configured = host.settings().read().ai.working_directory.trim().to_string();
    if !configured.is_empty() {
        return Some(PathBuf::from(configured));
    }
    let catalog = storage::Catalog::load_readonly(&host.config().user_data_dir, &host.config().settings_path).ok()?;
    catalog
        .list(PROJECTS)
        .into_iter()
        .find_map(|p| p["workspaceFolder"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from))
}

fn assignments_file(host: &HostContext) -> PathBuf {
    host.config().user_data_dir.join("issue-workflow-assignments.json")
}

fn read_assignments(host: &HostContext) -> BTreeMap<String, Value> {
    std::fs::read_to_string(assignments_file(host))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn assignment(host: &HostContext, issue_key: &str) -> Value {
    read_assignments(host).remove(issue_key).unwrap_or(Value::Null)
}

/// Assigns (or, with `None`, clears) the issue's pack; a manual choice, as the picker makes it.
pub fn assign(host: &HostContext, issue_key: &str, workflow: Option<Value>, source: &str) -> Result<(), String> {
    let mut all = read_assignments(host);
    match workflow {
        Some(workflow) => {
            all.insert(
                issue_key.to_string(),
                json!({
                    "workflow": workflow, "source": source,
                    "assignedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                }),
            );
        }
        None => {
            all.remove(issue_key);
        }
    }
    let raw = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    std::fs::write(assignments_file(host), format!("{raw}\n")).map_err(|e| e.to_string())?;
    host.events().emit(
        "ai:workflowAssignmentChanged",
        Some(json!({ "issueKey": issue_key, "assignment": all.get(issue_key) })),
    );
    Ok(())
}
