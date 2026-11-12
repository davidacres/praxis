//! Interactive ticket review. Ports `ticketReviewIpc.ts`, `ticketReviewApply.ts`,
//! `ticketSessionProject.ts` and `buildTicketReviewGoal` from the original.
//!
//! A review is a real, read-only agent session (stored under `review~<key>`, so reviewing a ticket
//! never replaces its implementation session) because only a session has a scope for its gadgets
//! to be issued against and a conversation for the user's answers to travel back on.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use praxis_contracts::RustRpcRequest;
use praxis_host::HostContext;
use serde_json::{Value, json};

use super::session_store::store;
use super::{Result, failure, text};

pub const CHANNELS: [&str; 2] = ["ai:startTicketReview", "ai:getTicketReview"];

const SESSION_PREFIX: &str = "review~";

pub fn session_key(issue_key: &str) -> String {
    format!("{SESSION_PREFIX}{issue_key}")
}

/// The reviewed ticket's key, or `None` when `session_key` is not a ticket review.
pub fn reviewed_issue_key(session_key: &str) -> Option<String> {
    session_key.strip_prefix(SESSION_PREFIX).map(str::trim).filter(|k| !k.is_empty()).map(str::to_owned)
}

fn host_call(host: &HostContext, channel: &str, args: Vec<Value>) -> std::result::Result<Value, String> {
    let response = host.dispatch_rpc(RustRpcRequest { id: "ticket-review".into(), channel: channel.into(), args });
    if response.ok { Ok(response.result.unwrap_or(Value::Null)) } else { Err(response.error.map_or_else(|| "The host returned no error.".to_owned(), |e| e.message)) }
}

// ── the goal ─────────────────────────────────────────────────────────────

/// The ticket as the agent reads it (`buildTicketContext`).
pub fn ticket_context(issue: &Value, recent_comment_limit: usize, newest_comments: bool, comment_body_limit: usize) -> String {
    let s = |field: &str| issue[field].as_str().filter(|v| !v.is_empty());
    let mut parts: Vec<String> = vec![format!("**Ticket:** {}", issue["key"].as_str().unwrap_or_default()), format!("**Type:** {}", issue["issueType"].as_str().unwrap_or_default()), format!("**Summary:** {}", issue["summary"].as_str().unwrap_or_default())];
    for (label, field) in [("Status", "status"), ("Priority", "priority"), ("Severity", "severity"), ("Complexity", "complexity"), ("Assignee", "assignee")] {
        if let Some(value) = s(field) {
            parts.push(format!("**{label}:** {value}"));
        }
    }
    if let Some(reporter) = s("reporter") {
        parts.push(format!("**Reporter:** {reporter}"));
    } else if let Some(reported_by) = s("reportedBy") {
        parts.push(format!("**Reported By:** {reported_by}"));
    }
    for (label, field) in [("Created", "created"), ("Updated", "updated"), ("Branch", "branch")] {
        if let Some(value) = s(field) {
            parts.push(format!("**{label}:** {value}"));
        }
    }
    if let Some(parent) = issue["parentIssue"].as_object() {
        let summary = parent.get("summary").and_then(Value::as_str).filter(|v| !v.is_empty()).map(|v| format!(" — {v}")).unwrap_or_default();
        parts.push(format!("**Parent:** {}{summary}", parent.get("key").and_then(Value::as_str).unwrap_or_default()));
    }
    if let Some(depends) = issue["dependsOn"].as_array().filter(|d| !d.is_empty()) {
        parts.push(format!("**Depends On:** {}", depends.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")));
    }
    match issue["description"].as_str().map(str::trim).filter(|d| !d.is_empty()) {
        Some(description) => parts.push(format!("\n**Description:**\n{description}")),
        None => parts.push("\n**Description:** *(none)*".to_owned()),
    }
    if let Some(transcript) = issue["ideaTranscript"].as_str().map(str::trim).filter(|d| !d.is_empty()) {
        let shown = if transcript.chars().count() > 2000 { format!("{}… *(truncated)*", transcript.chars().take(2000).collect::<String>()) } else { transcript.to_owned() };
        parts.push(format!("\n**Idea Transcript:**\n{shown}"));
    }
    if let Some(links) = issue["linkedIssues"].as_array().filter(|l| !l.is_empty()) {
        parts.push(format!("\n**Linked Issues ({}):**", links.len()));
        for link in links {
            let status = link["status"].as_str().filter(|v| !v.is_empty()).map(|v| format!(" [{v}]")).unwrap_or_default();
            let summary = link["summary"].as_str().filter(|v| !v.is_empty()).map(|v| format!(" — {v}")).unwrap_or_default();
            parts.push(format!("- {} {}{summary}{status}", link["relationship"].as_str().unwrap_or_default(), link["key"].as_str().unwrap_or_default()));
        }
    }
    if let Some(tasks) = issue["subTasks"].as_array().filter(|t| !t.is_empty()) {
        parts.push(format!("\n**Sub-Tasks ({}):**", tasks.len()));
        for task in tasks {
            let assignee = task["assignee"].as_str().filter(|v| !v.is_empty()).map(|v| format!(" ({v})")).unwrap_or_default();
            parts.push(format!("- {}: {} [{}]{assignee}", task["key"].as_str().unwrap_or_default(), task["summary"].as_str().unwrap_or_default(), task["status"].as_str().unwrap_or_default()));
        }
    }
    if let Some(comments) = issue["comments"].as_array().filter(|c| !c.is_empty()) {
        let limit = recent_comment_limit.min(comments.len());
        let visible: Vec<&Value> = if newest_comments { comments.iter().skip(comments.len() - limit).collect() } else { comments.iter().take(limit).collect() };
        parts.push(format!("\n**{} ({} total, showing {limit}):**", if newest_comments { "Recent comments" } else { "Comments" }, comments.len()));
        for comment in visible {
            let body = comment["body"].as_str().unwrap_or_default();
            let body = if body.chars().count() > comment_body_limit { format!("{}…", body.chars().take(comment_body_limit).collect::<String>()) } else { body.to_owned() };
            parts.push(format!("- **{}:** {body}", comment["author"].as_str().unwrap_or("Unknown")));
        }
    }
    if let Some(attachments) = issue["attachments"].as_array().filter(|a| !a.is_empty()) {
        parts.push(format!("\n**Attachments ({}):**", attachments.len()));
        for attachment in attachments {
            let size = attachment["sizeBytes"].as_f64().map(|b| format!(" ({} KB)", (b / 1024.0).round())).unwrap_or_default();
            let mime = attachment["mimeType"].as_str().filter(|v| !v.is_empty()).map(|v| format!(" [{v}]")).unwrap_or_default();
            parts.push(format!("- {}{size}{mime}", attachment["fileName"].as_str().unwrap_or_default()));
        }
    }
    parts.join("\n")
}

/// The goal for a ticket review: the ticket itself.
pub fn ticket_review_goal(issue: &Value) -> String {
    [
        format!("Review ticket {} — {}.", issue["key"].as_str().unwrap_or_default(), issue["summary"].as_str().unwrap_or_default()),
        ticket_context(issue, 10, true, 1200),
        "The text under **Description:** above is the ticket's current description. When you offer to update it, start from that exact text.".to_owned(),
    ]
    .join("\n\n")
}

// ── which project owns a ticket ──────────────────────────────────────────

/// Resolves ticket ownership from an explicit connection or a unique saved ticket.
fn resolve_ticket_project(host: &HostContext, connection_id: Option<&str>, issue_key: &str) -> Option<Value> {
    let projects = host_call(host, "projects:list", vec![]).ok()?;
    let projects = projects.as_array()?;
    if let Some(connection) = connection_id {
        let project_id = connection.strip_prefix("project:");
        if let Some(id) = project_id {
            return projects.iter().find(|p| p["id"] == id).cloned();
        }
    }
    let matches: Vec<&Value> = projects.iter().filter(|p| p["workItems"].as_array().is_some_and(|items| items.iter().any(|i| i["key"] == issue_key))).collect();
    (matches.len() == 1).then(|| matches[0].clone())
}

/// Older reviews saved the connection but omitted the owning project.
pub fn recover_projects(host: &HostContext, dir: &Path) {
    let sessions = store(dir);
    let Ok(all) = sessions.all() else { return };
    for (key, record) in all {
        if record["projectId"].as_str().is_some_and(|p| !p.is_empty()) {
            continue;
        }
        let Some(issue_key) = reviewed_issue_key(&key) else { continue };
        if let Some(project) = resolve_ticket_project(host, record["connectionId"].as_str(), &issue_key)
            && let Some(id) = project["id"].as_str()
        {
            let id = id.to_owned();
            let _ = sessions.mutate(&key, true, |r| r["projectId"] = json!(id));
        }
    }
}

// ── start / get ──────────────────────────────────────────────────────────

fn start(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    let issue_key = input["issueKey"].as_str().map(str::trim).unwrap_or_default().to_owned();
    if issue_key.is_empty() {
        return Err(failure("A ticket review needs an issue key."));
    }
    let connection_id = input["connectionId"].as_str().filter(|c| !c.is_empty()).map(str::to_owned);
    let issue = host_call(host, "issue:get", vec![json!(issue_key), connection_id.clone().map_or(Value::Null, Value::from)]).map_err(failure)?;
    let key = session_key(issue["key"].as_str().unwrap_or(&issue_key));
    let project = resolve_ticket_project(host, connection_id.as_deref(), issue["key"].as_str().unwrap_or(&issue_key));

    // A re-run replaces the previous review. Its gadgets belong to a session that is about to stop
    // existing, so they go with it rather than lingering as answerable-looking controls.
    let sessions = store(dir);
    if let Some(previous) = sessions.get(&key)? {
        if super::acp_host::has_active_task(dir, &key) {
            super::acp_host::abort_task(host, dir, &key);
        }
        if let Some(id) = previous["sessionId"].as_str() {
            super::gadget_service::clear_session(dir, id);
            forget_baseline(id);
        }
    }

    let mut review_issue = issue.clone();
    review_issue["key"] = json!(key);
    let mut launch = json!({
        "issueKey": key,
        "ticketReview": {
            "issue": review_issue,
            "task": {
                "kind": "ticket-review", "sessionMode": "review", "goal": ticket_review_goal(&issue),
                "scope": "Read-only review of this ticket and any workspace context it references.",
                "definitionOfDone": "A verdict is presented and each actionable finding is offered as a decision.",
                "nonGoals": ["Do not edit files or write to the tracker."],
                "completionContract": "Stop after presenting the review and wait for the user to answer the decisions.",
            },
        },
        "toolMode": "read-only",
    });
    for field in ["provider", "model", "connectionId"] {
        if !input[field].is_null() {
            launch[field] = input[field].clone();
        }
    }
    if let Some(project) = &project {
        launch["projectId"] = project["id"].clone();
        if let Some(folder) = project["workspaceFolder"].as_str().map(str::trim).filter(|f| !f.is_empty()) {
            launch["workingDirectory"] = json!(folder);
        }
    }
    super::ai_delegate::delegate_channel(host, dir, &[launch])?;

    let record = sessions.get(&key)?.ok_or_else(|| failure(format!("The review of {} did not start.", issue["key"].as_str().unwrap_or(&issue_key))))?;
    let title = format!("Review {} — {}", issue["key"].as_str().unwrap_or_default(), issue["summary"].as_str().unwrap_or_default());
    let _ = sessions.mutate(&key, true, |r| r["title"] = json!(title));
    if let Some(id) = record["sessionId"].as_str() {
        record_baseline(id, &issue);
    }
    sessions.get(&key)?.map(super::session_store::stamp_reasoning).ok_or_else(|| failure("The review did not start."))
}

fn get(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    recover_projects(host, dir);
    let key = session_key(text(args, 0)?);
    Ok(store(dir).get(&key)?.map_or(Value::Null, super::session_store::stamp_reasoning))
}

pub fn dispatch(host: &HostContext, dir: &Path, channel: &str, args: &[Value]) -> Option<Result<Value>> {
    Some(match channel {
        "ai:startTicketReview" => start(host, dir, args),
        "ai:getTicketReview" => get(host, dir, args),
        _ => return None,
    })
}

// ── applying an approved review ──────────────────────────────────────────

/// The description and summary the review last read or wrote, per review session. The agent
/// rewrote the description from a snapshot; applying that over a description someone edited in the
/// meantime would silently discard their edit. In memory on purpose: after a restart there is no
/// baseline, and the check is skipped rather than blocking every apply.
fn baselines() -> &'static Mutex<HashMap<String, (String, String)>> {
    static BASELINES: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
    BASELINES.get_or_init(Default::default)
}

fn record_baseline(session_id: &str, ticket: &Value) {
    if let Ok(mut all) = baselines().lock() {
        all.insert(session_id.to_owned(), (ticket["summary"].as_str().unwrap_or_default().to_owned(), ticket["description"].as_str().unwrap_or_default().to_owned()));
    }
}

fn forget_baseline(session_id: &str) {
    if let Ok(mut all) = baselines().lock() {
        all.remove(session_id);
    }
}

fn field(fields: &BTreeMap<String, Value>, name: &str) -> String {
    fields.get(name).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_owned()
}

/// What an apply actually did to the ticket fields, versus what the form merely sent.
pub fn describe_applied_changes(before: &Value, summary: &str, description: &str) -> Option<String> {
    let normalized = |v: &str| v.trim().to_owned();
    let changed_summary = !summary.is_empty() && normalized(summary) != normalized(before["summary"].as_str().unwrap_or_default());
    let changed_description = !description.is_empty() && normalized(description) != normalized(before["description"].as_str().unwrap_or_default());
    let changed: Vec<&str> = [changed_summary.then_some("summary"), changed_description.then_some("description")].into_iter().flatten().collect();
    (!changed.is_empty()).then(|| format!("updated the {}", changed.join(" and ")))
}

/// Writes an approved ticket review to the tracker. Refuses any session that is not a ticket
/// review, so a gadget from an ordinary chat cannot borrow the gate to edit tickets.
pub fn apply_ticket_review(host: &HostContext, dir: &Path, session_id: &str, fields: &BTreeMap<String, Value>) -> std::result::Result<(Value, String), String> {
    let record = store(dir).all().ok().and_then(|all| all.into_values().find(|r| r["sessionId"] == session_id));
    let issue_key = record.as_ref().and_then(|r| r["issueKey"].as_str()).and_then(reviewed_issue_key);
    let (Some(record), Some(issue_key)) = (record, issue_key) else { return Err("Ticket changes can only be applied from a ticket review.".into()) };
    let (summary, description, comment) = (field(fields, "summary"), field(fields, "description"), field(fields, "comment"));
    if summary.is_empty() && description.is_empty() && comment.is_empty() {
        return Err("There is nothing to apply — fill in at least one field.".into());
    }
    let connection = record["connectionId"].as_str().filter(|c| !c.is_empty()).map_or(Value::Null, Value::from);
    let changes_ticket = !summary.is_empty() || !description.is_empty();
    let before = if changes_ticket { Some(host_call(host, "issue:get", vec![json!(issue_key), connection.clone()])?) } else { None };
    let baseline = baselines().lock().ok().and_then(|all| all.get(session_id).cloned());
    if let (Some(before), Some((base_summary, base_description))) = (&before, &baseline) {
        let edited = (!description.is_empty() && before["description"].as_str().unwrap_or_default().trim() != base_description.trim()) || (!summary.is_empty() && before["summary"].as_str().unwrap_or_default().trim() != base_summary.trim());
        if edited {
            return Err(format!("{issue_key} was edited after this review started, so applying now would overwrite that edit. Run the review again to work from the current ticket."));
        }
    }
    let mut applied: Vec<String> = Vec::new();
    if let Some(before) = &before {
        let mut patch = json!({});
        if !summary.is_empty() {
            patch["summary"] = json!(summary);
        }
        if !description.is_empty() {
            patch["description"] = json!(description);
        }
        let updated = host_call(host, "issue:update", vec![json!(issue_key), patch, connection.clone()])?;
        record_baseline(session_id, &updated);
        match describe_applied_changes(before, &summary, &description) {
            Some(label) => applied.push(label),
            // Every field it sent matched what was already there: say so plainly.
            None if comment.is_empty() => applied.push("nothing changed — the ticket already matched".into()),
            None => {}
        }
    }
    if !comment.is_empty() {
        host_call(host, "issue:addComment", vec![json!(issue_key), json!(comment), connection])?;
        applied.push("posted a comment".into());
    }
    Ok((json!({ "issueKey": issue_key, "summary": !summary.is_empty(), "description": !description.is_empty(), "comment": !comment.is_empty() }), format!("Applied to {issue_key}: {}.", applied.join(" and "))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_sessions_are_keyed_apart_from_the_ticket() {
        assert_eq!(session_key("APP-1"), "review~APP-1");
        assert_eq!(reviewed_issue_key("review~APP-1").as_deref(), Some("APP-1"));
        assert_eq!(reviewed_issue_key("APP-1"), None);
        assert_eq!(reviewed_issue_key("review~"), None);
    }

    #[test]
    fn the_goal_carries_the_ticket_and_its_current_description() {
        let issue = json!({ "key": "APP-1", "issueType": "Task", "summary": "Fix it", "status": "To do", "description": "Original.", "comments": [{ "author": "Ann", "body": "Why?" }] });
        let goal = ticket_review_goal(&issue);
        assert!(goal.starts_with("Review ticket APP-1 — Fix it."));
        assert!(goal.contains("**Description:**\nOriginal."));
        assert!(goal.contains("**Recent comments (1 total, showing 1):**"));
        assert!(goal.contains("- **Ann:** Why?"));
    }

    #[test]
    fn an_apply_only_claims_what_changed() {
        let before = json!({ "summary": "Same", "description": "Old" });
        assert_eq!(describe_applied_changes(&before, "Same", "New").as_deref(), Some("updated the description"));
        assert_eq!(describe_applied_changes(&before, "Other", "New").as_deref(), Some("updated the summary and description"));
        assert_eq!(describe_applied_changes(&before, "Same", "Old"), None);
    }
}
