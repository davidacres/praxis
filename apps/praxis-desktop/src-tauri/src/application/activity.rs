//! Project activity store and git commit history aggregation.
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

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
            let (started_at, stored) = open(root, project_id)?;
            // Commits are read from the repository on demand, never copied into the store.
            let mut merged: Vec<Value> = stored.into_iter().rev().collect();
            merged.extend(read_git_commits(host, &project, project_id));
            merged.sort_by(|a, b| {
                let ts_a = a["timestamp"].as_str().unwrap_or("");
                let ts_b = b["timestamp"].as_str().unwrap_or("");
                ts_b.cmp(ts_a)
            });
            Ok(json!({
                "startedAt": started_at,
                "entries": merged
            }))
        }
        _ => Err(failure(format!("Unsupported activity channel: {channel}"))),
    }
}

const MAX_STORED_ENTRIES: usize = 1000;

/// Observers record from file-watcher threads while `activity:list` reads on the
/// RPC thread; both rewrite the same file.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// The stored observations for one project (oldest first, last 30 days) and
/// when observation began; persisted so `startedAt` stays fixed.
fn open(root: &Path, project_id: &str) -> Result<(String, Vec<Value>)> {
    let _guard = STORE_LOCK.lock().map_err(failure)?;
    open_locked(root, project_id)
}

fn open_locked(root: &Path, project_id: &str) -> Result<(String, Vec<Value>)> {
    let file_path = root.join("project-activity.json");
    let raw = storage::read(&file_path)?;
    let mut doc = storage::parse(&file_path, raw.as_deref())?;
    let key = format!("activity:{project_id}");
    let snapshot = doc.get(&key).cloned().unwrap_or(Value::Null);
    let started_at = snapshot["startedAt"]
        .as_str()
        .map(ToString::to_string)
        .unwrap_or_else(now);
    let cutoff = Utc::now() - Duration::days(30);
    let mut entries: Vec<Value> = snapshot["entries"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry["projectId"] == project_id && entry["kind"] != "commit")
        .filter(|entry| {
            entry["timestamp"]
                .as_str()
                .and_then(|ts| DateTime::parse_from_rfc3339(ts).ok())
                .is_some_and(|ts| ts.with_timezone(&Utc) >= cutoff)
        })
        .collect();
    if entries.len() > MAX_STORED_ENTRIES {
        entries.drain(..entries.len() - MAX_STORED_ENTRIES);
    }
    doc[key] = json!({ "startedAt": started_at, "entries": entries });
    storage::write_atomic(&file_path, &storage::encoded(&doc)?, false)?;
    Ok((started_at, entries))
}

thread_local! {
    static AGENT_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Board writes made inside `work` (on this thread) are attributed to the agent, not the person.
pub fn run_as_agent<T>(work: impl FnOnce() -> T) -> T {
    let previous = AGENT_WRITE.with(|flag| flag.replace(true));
    let result = work();
    AGENT_WRITE.with(|flag| flag.set(previous));
    result
}

/// The actor for a board write observed right now.
pub fn current_actor() -> &'static str {
    if AGENT_WRITE.with(std::cell::Cell::get) {
        "agent"
    } else {
        "you"
    }
}

/// Records a session's state change as agent activity on its project (once per distinct state).
pub fn observe_session(root: &Path, session: &Value) {
    use std::collections::HashMap;
    use std::sync::{Mutex as StdMutex, OnceLock};
    static LAST_STATE: OnceLock<StdMutex<HashMap<String, String>>> = OnceLock::new();
    let (Some(project_id), Some(session_id), Some(state)) = (
        session["projectId"].as_str().filter(|p| !p.is_empty()),
        session["sessionId"].as_str(),
        session["state"].as_str(),
    ) else {
        return;
    };
    let changed = LAST_STATE
        .get_or_init(Default::default)
        .lock()
        .map(|mut all| {
            all.insert(session_id.to_owned(), state.to_owned())
                .as_deref()
                != Some(state)
        })
        .unwrap_or(false);
    if !changed {
        return;
    }
    let issue_key = session["issueKey"].as_str().unwrap_or_default();
    let title = session["title"]
        .as_str()
        .filter(|t| !t.is_empty())
        .unwrap_or(issue_key);
    record(
        root,
        &Observation {
            project_id,
            kind: "session",
            target_key: issue_key,
            summary: title,
            action: &format!("Session {}", state.replace('_', " ")),
            connection_id: None,
            actor: "agent",
        },
    );
}

/// One observation of a change made through Praxis (or noticed on disk).
pub struct Observation<'a> {
    pub project_id: &'a str,
    pub kind: &'a str,
    pub target_key: &'a str,
    pub summary: &'a str,
    pub action: &'a str,
    pub connection_id: Option<&'a str>,
    pub actor: &'a str,
}

/// Append an observation to the project's activity store. Best effort: the
/// change being observed has already succeeded and must not fail because of it.
pub fn record(root: &Path, observation: &Observation<'_>) {
    let result = (|| -> Result<()> {
        let _guard = STORE_LOCK.lock().map_err(failure)?;
        let (started_at, mut entries) = open_locked(root, observation.project_id)?;
        let timestamp = now();
        let mut entry = json!({
            "id": format!("{timestamp}:{}", uuid::Uuid::new_v4().simple()),
            "projectId": observation.project_id,
            "kind": observation.kind,
            "targetKey": observation.target_key,
            "summary": observation.summary,
            "action": observation.action,
            "timestamp": timestamp,
            "actor": observation.actor
        });
        if let Some(connection_id) = observation.connection_id {
            entry["connectionId"] = json!(connection_id);
        }
        entries.push(entry);
        if entries.len() > MAX_STORED_ENTRIES {
            entries.drain(..entries.len() - MAX_STORED_ENTRIES);
        }
        let file_path = root.join("project-activity.json");
        let raw = storage::read(&file_path)?;
        let mut doc = storage::parse(&file_path, raw.as_deref())?;
        doc[format!("activity:{}", observation.project_id)] =
            json!({ "startedAt": started_at, "entries": entries });
        storage::write_atomic(&file_path, &storage::encoded(&doc)?, false)
    })();
    if let Err(error) = result {
        eprintln!("Could not save project activity: {}", error.message);
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
