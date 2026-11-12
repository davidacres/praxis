//! Handing a session to another provider or model. Ports `sessionHandover.ts` from core and the
//! runtime-transition rules of `AiSessionManager`: the purpose and living brief a session carries,
//! the epochs of runtimes it has run on, and the envelope the next AI is given.

use serde_json::{Value, json};

use super::{Result, failure, now};

pub const SCHEMA_VERSION: u64 = 1;

pub fn purpose_from_task(task: &Value, issue_key: &str, title: Option<&str>) -> Value {
    let trimmed = |field: &str| task[field].as_str().unwrap_or_default().trim().to_owned();
    let mut purpose = json!({
        "issueKey": issue_key,
        "goal": trimmed("goal"),
        "scope": trimmed("scope"),
        "definitionOfDone": trimmed("definitionOfDone"),
    });
    if let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) {
        purpose["title"] = json!(title);
    }
    purpose
}

pub fn empty_brief(at: &str) -> Value {
    json!({
        "schemaVersion": SCHEMA_VERSION, "revision": 0, "updatedAt": at, "sourceEventCount": 0, "freshness": "fresh",
        "progress": "Session has not produced work yet.", "changes": "", "decisions": "", "risks": "", "openQuestions": "",
        "nextSteps": "", "userNotes": "", "touchedFiles": []
    })
}

pub fn new_epoch_id() -> String {
    format!(
        "epoch-{:x}-{}",
        chrono::Utc::now().timestamp_millis(),
        &uuid::Uuid::new_v4().simple().to_string()[..6]
    )
}

/// The brief of a record, filling in what an older record lacks.
fn brief_of(record: &Value) -> Value {
    let mut brief = if record["handoverBrief"].is_object() {
        record["handoverBrief"].clone()
    } else {
        empty_brief(record["startedAt"].as_str().unwrap_or_default())
    };
    let defaults = empty_brief(brief["updatedAt"].as_str().unwrap_or_default());
    for (field, value) in defaults.as_object().into_iter().flatten() {
        if brief[field].is_null() {
            brief[field] = value.clone();
        }
    }
    brief
}

fn purpose_of_record(record: &Value) -> Value {
    if record["purpose"].is_object() {
        return record["purpose"].clone();
    }
    purpose_from_task(
        &record["taskDefinition"],
        record["issueKey"].as_str().unwrap_or_default(),
        record["title"].as_str(),
    )
}

fn clip(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_owned();
    }
    format!("{}…", trimmed.chars().take(max - 1).collect::<String>())
}

/// First prose block, without markdown tables.
fn summarise(text: &str, max: usize) -> String {
    let table = regex::Regex::new(r"(?m)^\s*\|.*\|\s*$").expect("static pattern");
    let blank = regex::Regex::new(r"\n{3,}").expect("static pattern");
    let without = blank
        .replace_all(&table.replace_all(text, ""), "\n\n")
        .trim()
        .to_owned();
    let first = regex::Regex::new(r"\n\n+")
        .expect("static pattern")
        .split(&without)
        .next()
        .unwrap_or(&without)
        .to_owned();
    clip(&first, max)
}

/// Strips obvious secret-shaped values from portable handover prose.
pub fn redact(text: &str) -> String {
    let assignment =
        regex::Regex::new(r"(?i)(token|secret|password|apikey|api_key|\bpat\b)\s*[:=]\s*\S+")
            .expect("static pattern");
    let tokens = regex::Regex::new(r"\b(ghp|gho|github_pat|glpat|sk-)[A-Za-z0-9_-]{8,}\b")
        .expect("static pattern");
    tokens
        .replace_all(
            &assignment.replace_all(text, "$1: [redacted]"),
            "[redacted]",
        )
        .into_owned()
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .into_iter()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty() && seen.insert(v.clone()))
        .collect()
}

pub fn touched_files(events: &[Value]) -> Vec<String> {
    let paths = events
        .iter()
        .flat_map(|e| e["data"]["fileChanges"].as_array().into_iter().flatten())
        .filter_map(|c| c["path"].as_str())
        .map(str::to_owned);
    unique(paths).into_iter().take(40).collect()
}

fn text_of(event: &Value) -> String {
    event["detail"]
        .as_str()
        .filter(|d| !d.trim().is_empty())
        .or_else(|| event["summary"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// The brief a session's own record supports, with no model involved.
pub fn deterministic_brief(record: &Value) -> Value {
    let events = record["events"].as_array().cloned().unwrap_or_default();
    let last_message = events
        .iter()
        .rfind(|e| e["type"] == "message" && !text_of(e).trim().is_empty());
    let errors = unique(
        events
            .iter()
            .filter(|e| e["type"] == "error")
            .filter_map(|e| e["summary"].as_str().map(str::to_owned)),
    );
    let files = touched_files(&events);
    let tasks = record["taskList"].as_array().cloned().unwrap_or_default();
    let completed: Vec<String> = tasks
        .iter()
        .filter(|t| t["status"] == "completed")
        .filter_map(|t| t["content"].as_str().map(str::to_owned))
        .collect();
    let pending: Vec<String> = tasks
        .iter()
        .filter(|t| t["status"] != "completed")
        .filter_map(|t| t["content"].as_str().map(str::to_owned))
        .collect();
    let progress = match last_message {
        Some(message) => summarise(&text_of(message), 240),
        None if events.iter().any(|e| e["type"] == "session_start") => {
            "Session started; no assistant reply has been recorded yet.".into()
        }
        None => "Session has not produced work yet.".into(),
    };
    let changes = if files.is_empty() {
        "No file changes have been recorded.".to_owned()
    } else {
        format!(
            "Touched {} file{}: {}{}.",
            files.len(),
            if files.len() == 1 { "" } else { "s" },
            files
                .iter()
                .take(12)
                .cloned()
                .collect::<Vec<_>>()
                .join(", "),
            if files.len() > 12 { "…" } else { "" }
        )
    };
    let next_steps = if !pending.is_empty() {
        pending
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("; ")
    } else if matches!(
        record["state"].as_str(),
        Some("completed" | "paused" | "not_started")
    ) {
        "Await the next user instruction.".into()
    } else {
        "Continue the current task.".into()
    };
    json!({
        "progress": redact(&progress), "changes": redact(&changes),
        "decisions": redact(&completed.iter().take(8).cloned().collect::<Vec<_>>().join("; ")),
        "risks": redact(&errors.iter().take(6).cloned().collect::<Vec<_>>().join("; ")),
        "openQuestions": redact(if events.iter().any(|e| e["type"] == "permission_requested") { "A permission request was raised during this session." } else { "" }),
        "nextSteps": redact(&next_steps), "touchedFiles": files,
    })
}

/// Commits refreshed content onto a brief as its next revision.
pub fn apply_content(previous: &Value, content: &Value, source_event_count: usize) -> Value {
    let mut brief = previous.clone();
    brief["schemaVersion"] = json!(SCHEMA_VERSION);
    brief["revision"] = json!(previous["revision"].as_u64().unwrap_or(0) + 1);
    brief["updatedAt"] = json!(now());
    brief["sourceEventCount"] = json!(source_event_count);
    brief["freshness"] = json!("fresh");
    brief.as_object_mut().map(|o| o.remove("lastError"));
    for field in [
        "progress",
        "changes",
        "decisions",
        "risks",
        "openQuestions",
        "nextSteps",
        "touchedFiles",
    ] {
        brief[field] = content[field].clone();
    }
    brief
}

/// Applies the user's edits to a brief, refusing when it moved on since they started.
pub fn apply_user_edits(previous: &Value, expected_revision: u64, edits: &Value) -> Result<Value> {
    if previous["revision"].as_u64() != Some(expected_revision) {
        return Err(failure(
            "The handover brief changed while you were editing. Reload and try again.",
        ));
    }
    let mut brief = previous.clone();
    brief["revision"] = json!(expected_revision + 1);
    brief["updatedAt"] = json!(now());
    brief["freshness"] = json!(if previous["freshness"] == "updating" {
        "updating"
    } else {
        "fresh"
    });
    for field in [
        "progress",
        "changes",
        "decisions",
        "risks",
        "openQuestions",
        "nextSteps",
        "userNotes",
    ] {
        if let Some(value) = edits[field].as_str() {
            brief[field] = json!(value);
        }
    }
    Ok(brief)
}

/// Refreshes a record's brief deterministically (the record's events are its source).
pub fn refreshed_brief(record: &Value) -> Value {
    let previous = brief_of(record);
    apply_content(
        &previous,
        &deterministic_brief(record),
        record["events"].as_array().map_or(0, Vec::len),
    )
}

fn compact_transcript(events: &[Value]) -> String {
    const MAX: usize = 6000;
    let mut turns: Vec<String> = Vec::new();
    for event in events {
        let text = text_of(event);
        match event["type"].as_str() {
            Some("message") if !text.trim().is_empty() => {
                turns.push(format!("Assistant:\n{}", clip(&text, 1200)))
            }
            Some("user_input_completed") if !text.trim().is_empty() => {
                turns.push(format!("User:\n{}", clip(&text, 800)))
            }
            Some(kind @ ("model_change" | "provider_handover")) => turns.push(format!(
                "{kind}: {}",
                event["summary"].as_str().unwrap_or_default()
            )),
            _ => {}
        }
    }
    let mut text = turns.join("\n\n");
    if text.chars().count() > MAX {
        let skip = text.chars().count() - MAX;
        text = format!("…\n{}", text.chars().skip(skip).collect::<String>());
    }
    redact(&text)
}

/// The text the next AI is given when it takes a session over.
pub fn envelope_text(record: &Value, snapshot: Option<&Value>) -> String {
    let purpose = purpose_of_record(record);
    let brief = brief_of(record);
    let events = record["events"].as_array().cloned().unwrap_or_default();
    let transcript = compact_transcript(&events);
    let field = |value: &Value, name: &str| value[name].as_str().unwrap_or_default().to_owned();
    let workspace = [
        record["workingDirectory"]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(|v| format!("Working directory: {v}")),
        record["worktreePath"]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(|v| format!("Worktree: {v}")),
        record["worktreeBranch"]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(|v| format!("Branch: {v}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n");
    let optional = |label: &str, value: String| {
        if value.is_empty() {
            String::new()
        } else {
            format!("{label}: {value}")
        }
    };
    let files = brief["touchedFiles"]
        .as_array()
        .map(|f| {
            f.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let lines = [
        "# Session handover".to_owned(),
        String::new(),
        format!(
            "You are taking over this Praxis session from {}{}.",
            record["provider"]
                .as_str()
                .unwrap_or("the previous provider"),
            record["model"]
                .as_str()
                .filter(|m| !m.is_empty())
                .map(|m| format!(" ({m})"))
                .unwrap_or_default()
        ),
        "Inspect the current files rather than treating this summary as complete.".to_owned(),
        String::new(),
        "## Purpose".to_owned(),
        optional("Title", field(&purpose, "title")),
        format!("Issue: {}", field(&purpose, "issueKey")),
        format!("Goal: {}", field(&purpose, "goal")),
        optional("Scope", field(&purpose, "scope")),
        optional("Definition of done", field(&purpose, "definitionOfDone")),
        String::new(),
        "## Current brief".to_owned(),
        format!("Progress: {}", field(&brief, "progress")),
        format!("Changes: {}", field(&brief, "changes")),
        optional("Decisions", field(&brief, "decisions")),
        optional("Risks", field(&brief, "risks")),
        optional("Open questions", field(&brief, "openQuestions")),
        format!("Next steps: {}", field(&brief, "nextSteps")),
        optional("User notes", field(&brief, "userNotes")),
        optional("Files", files),
        String::new(),
        if workspace.is_empty() {
            String::new()
        } else {
            format!("## Workspace\n{workspace}")
        },
        snapshot
            .map(super::context_snapshot::format_snapshot)
            .unwrap_or_default(),
        if transcript.is_empty() {
            String::new()
        } else {
            format!("## Conversation\n{transcript}")
        },
        String::new(),
        "Continue the work described in Next steps.".to_owned(),
    ];
    redact(&lines.join("\n"))
}

pub fn assert_can_change_runtime(record: &Value) -> Result<()> {
    match record["state"].as_str() {
        Some(state @ ("planning" | "executing")) => Err(failure(format!(
            "Wait until this turn finishes before changing provider or model (session is {state})."
        ))),
        _ => Ok(()),
    }
}

/// Closes the open epoch and opens a new one on the record.
pub fn append_epoch(record: &mut Value, provider: Option<&str>, model: Option<&str>, reason: &str) {
    let started = now();
    let mut epochs = record["runtimeEpochs"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(last) = epochs.last_mut()
        && last["endedAt"].is_null()
    {
        last["endedAt"] = json!(started);
    }
    let mut epoch = json!({ "id": new_epoch_id(), "startedAt": started, "reason": reason });
    if let Some(provider) = provider {
        epoch["provider"] = json!(provider);
    }
    if let Some(model) = model {
        epoch["model"] = json!(model);
    }
    epochs.push(epoch);
    record["runtimeEpochs"] = json!(epochs);
}

/// Changes the provider and/or model of a record in place (`transitionAgentRuntime`).
pub fn transition_runtime(
    record: &mut Value,
    provider: Option<&str>,
    model: Option<&str>,
    reason: &str,
    clear_native: bool,
    summary: &str,
    detail: Option<&str>,
) -> Result<()> {
    assert_can_change_runtime(record)?;
    let provider = provider
        .map(str::to_owned)
        .or_else(|| record["provider"].as_str().map(str::to_owned));
    let model = model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    append_epoch(record, provider.as_deref(), model.as_deref(), reason);
    record["provider"] = json!(provider);
    match &model {
        Some(model) => record["model"] = json!(model),
        None => {
            record.as_object_mut().map(|o| o.remove("model"));
        }
    }
    // A limit hit on the old runtime says nothing about the new one.
    for field in ["lastError", "providerLimitReached"] {
        record.as_object_mut().map(|o| o.remove(field));
    }
    if clear_native {
        for field in [
            "runtimeSessionId",
            "acpAvailableCommands",
            "acpCurrentModeId",
            "acpAvailableModes",
            "contextTokens",
            "contextLimit",
        ] {
            record.as_object_mut().map(|o| o.remove(field));
        }
        let stamp = now();
        if let Some(tasks) = record["backgroundTasks"].as_array_mut() {
            for task in tasks.iter_mut().filter(|t| {
                t["source"] == "provider"
                    && matches!(t["state"].as_str(), Some("running" | "paused" | "unknown"))
            }) {
                task["state"] = json!("stopped");
                task["updatedAt"] = json!(stamp);
                if task["completedAt"].is_null() {
                    task["completedAt"] = json!(stamp);
                }
            }
        }
    }
    let mut event = json!({ "timestamp": now(), "type": reason, "summary": summary });
    if let Some(detail) = detail {
        event["detail"] = json!(detail);
    }
    let mut events = record["events"].as_array().cloned().unwrap_or_default();
    events.push(event);
    record["eventCount"] = json!(events.len());
    record["events"] = json!(events);
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn record() -> Value {
        json!({
            "issueKey": "SESSION-1", "provider": "vercel-gateway", "model": "m1", "state": "completed", "startedAt": "2026-01-01T00:00:00Z",
            "taskDefinition": { "goal": "Ship it", "scope": "All", "definitionOfDone": "Done" },
            "events": [
                { "type": "user_input_completed", "summary": "You", "detail": "Do the thing" },
                { "type": "message", "summary": "Finished. token: abc123", "timestamp": "t" },
            ],
            "runtimeEpochs": [{ "id": "e1", "provider": "vercel-gateway", "startedAt": "2026-01-01T00:00:00Z", "reason": "started" }],
        })
    }

    #[test]
    fn envelope_names_the_previous_runtime_and_redacts_secrets() {
        let text = envelope_text(&record(), None);
        assert!(text.contains("taking over this Praxis session from vercel-gateway (m1)"));
        assert!(text.contains("Goal: Ship it"));
        assert!(text.contains("[redacted]"));
        assert!(!text.contains("abc123"));
    }

    #[test]
    fn transition_closes_the_epoch_and_clears_limit_flags() {
        let mut value = record();
        value["providerLimitReached"] = json!(true);
        value["lastError"] = json!("limit");
        transition_runtime(
            &mut value,
            Some("openai"),
            Some("gpt"),
            "provider_handover",
            true,
            "Handed over",
            None,
        )
        .unwrap();
        assert_eq!(value["provider"], "openai");
        assert_eq!(value["runtimeEpochs"].as_array().unwrap().len(), 2);
        assert!(value["runtimeEpochs"][0]["endedAt"].is_string());
        assert!(value["lastError"].is_null() && value["providerLimitReached"].is_null());
        assert_eq!(
            value["events"].as_array().unwrap().last().unwrap()["type"],
            "provider_handover"
        );
    }

    #[test]
    fn a_busy_session_cannot_change_runtime() {
        let mut value = record();
        value["state"] = json!("executing");
        assert!(
            transition_runtime(
                &mut value,
                Some("openai"),
                None,
                "model_change",
                false,
                "x",
                None
            )
            .is_err()
        );
    }

    #[test]
    fn stale_brief_edits_are_refused() {
        let brief = empty_brief("now");
        assert!(apply_user_edits(&brief, 3, &json!({})).is_err());
        let edited = apply_user_edits(&brief, 0, &json!({ "userNotes": "keep tests" })).unwrap();
        assert_eq!(edited["revision"], 1);
        assert_eq!(edited["userNotes"], "keep tests");
    }
}
