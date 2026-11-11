//! Project activity store and git commit history aggregation.
use std::path::Path;
use std::process::Command;

use chrono::{DateTime, Duration, Utc};
use praxis_host::HostContext;
use regex::Regex;
use serde_json::{Value, json};

use super::{Catalog, Result, failure, now, storage};

const GIT_LOG_FORMAT: &str =
    "%H\x1f%an\x1f%ae\x1f%aI\x1f%s\x1f%(trailers:key=Co-authored-by,valueonly,separator=%x2C)\x1e";

pub fn dispatch(
    host: &HostContext,
    catalog: &mut Catalog,
    root: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "activity:list" => {
            let project_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| failure("activity:list requires a projectId argument."))?;
            let project = catalog.require(storage::PROJECTS, project_id)?;
            let file_path = root.join("project-activity.json");
            let raw = storage::read(&file_path)?;
            let mut doc = storage::parse(&file_path, raw.as_deref())?;

            let activity_key = format!("activity:{project_id}");
            let snapshot = doc.get(&activity_key).cloned().unwrap_or_else(|| {
                json!({
                    "startedAt": now(),
                    "entries": []
                })
            });

            let started_at = snapshot["startedAt"]
                .as_str()
                .map(ToString::to_string)
                .unwrap_or_else(now);

            let thirty_days_ago = Utc::now() - Duration::days(30);

            let mut stored_entries = Vec::new();
            if let Some(entries) = snapshot["entries"].as_array() {
                for entry in entries {
                    if let Some(ts_str) = entry["timestamp"].as_str()
                        && let Ok(ts) = DateTime::parse_from_rfc3339(ts_str)
                        && ts.with_timezone(&Utc) >= thirty_days_ago
                    {
                        stored_entries.push(entry.clone());
                    }
                }
            }

            let commit_entries = read_git_commits(host, &project, project_id);

            let mut merged = stored_entries;
            merged.extend(commit_entries);
            merged.sort_by(|a, b| {
                let ts_a = a["timestamp"].as_str().unwrap_or("");
                let ts_b = b["timestamp"].as_str().unwrap_or("");
                ts_b.cmp(ts_a)
            });

            doc[activity_key] = json!({
                "startedAt": started_at,
                "entries": merged
            });
            let encoded = storage::encoded(&doc)?;
            storage::write_atomic(&file_path, &encoded, false)?;

            Ok(json!({
                "startedAt": started_at,
                "entries": merged
            }))
        }
        _ => Err(failure(format!("Unsupported activity channel: {channel}"))),
    }
}

fn read_git_commits(host: &HostContext, project: &Value, project_id: &str) -> Vec<Value> {
    let Some(folder) = project["workspaceFolder"].as_str() else {
        return Vec::new();
    };
    let folder_path = Path::new(folder);
    if !folder_path.join(".git").exists() {
        return Vec::new();
    }

    let git_bin = host.git_service().git_executable();
    let log_output = Command::new(&git_bin)
        .current_dir(folder_path)
        .args([
            "log",
            "--since=30.days",
            "--max-count=500",
            &format!("--format={GIT_LOG_FORMAT}"),
        ])
        .output();

    let Ok(output) = log_output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let self_email = Command::new(&git_bin)
        .current_dir(folder_path)
        .args(["config", "user.email"])
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                String::from_utf8(out.stdout)
                    .ok()
                    .map(|s| s.trim().to_lowercase())
            } else {
                None
            }
        });

    let Ok(agent_regex) = Regex::new(
        r"(?i)\b(claude|copilot|codex|gemini|cursor(?:agent)?|devin|aider)\b|noreply@anthropic\.com|openai\.com",
    ) else {
        return Vec::new();
    };

    let log_str = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();

    for record in log_str.split('\x1e') {
        let clean_record = record.trim_start_matches('\n');
        if clean_record.is_empty() {
            continue;
        }
        let parts: Vec<&str> = clean_record.split('\x1f').collect();
        if parts.len() < 5 {
            continue;
        }
        let hash = parts[0];
        let name = parts.get(1).copied().unwrap_or("");
        let email = parts.get(2).copied().unwrap_or("");
        let date = parts.get(3).copied().unwrap_or("");
        let subject = parts.get(4).copied().unwrap_or("");
        let co_authors = parts.get(5).copied().unwrap_or("");

        if hash.len() < 7 || DateTime::parse_from_rfc3339(date).is_err() {
            continue;
        }

        let is_agent =
            agent_regex.is_match(&format!("{name} {email}")) || agent_regex.is_match(co_authors);
        let actor = if is_agent {
            "agent"
        } else if let Some(ref self_e) = self_email
            && !self_e.is_empty()
            && email.trim().to_lowercase() == *self_e
        {
            "you"
        } else {
            "external"
        };

        let summary = if !subject.trim().is_empty() {
            subject.trim()
        } else {
            &hash[..7.min(hash.len())]
        };

        let mut entry = json!({
            "id": format!("commit:{hash}"),
            "projectId": project_id,
            "kind": "commit",
            "targetKey": hash,
            "summary": summary,
            "action": "Committed",
            "timestamp": date,
            "actor": actor
        });

        if actor == "external" && !name.trim().is_empty() {
            entry["actorName"] = json!(name.trim());
        }

        entries.push(entry);
    }

    entries
}
