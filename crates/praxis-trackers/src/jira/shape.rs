//! Defensive Jira/MCP JSON normalization (`jira/jiraShape.ts`).
//!
//! Descriptions are flattened ADF text, as in the current host; this is not an ADF
//! renderer or a bidirectional Markdown converter.

use crate::rest_support::as_string;
use praxis_contracts::{
    IssueComment, IssueSummary, ParentIssueReference, Project, WorkflowTransition,
};
use serde_json::Value;
use std::collections::HashSet;

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn string(value: &Value) -> Option<String> {
    as_string(Some(value))
}
fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty())
}
fn trimmed(value: &Value) -> Option<String> {
    nonempty(string(value).map(|s| s.trim_matches(js_whitespace).to_owned()))
}
fn fields(value: &Value) -> &Value {
    value
        .get("fields")
        .filter(|v| v.is_object() || v.is_array())
        .unwrap_or(value)
}

/// Remove exactly one trailing slash, matching the TypeScript helper.
pub fn derive_browse_url(base: &str, key: &str) -> String {
    format!("{}/browse/{key}", base.strip_suffix('/').unwrap_or(base))
}

/// Plain strings stay untouched; nested ADF nodes collapse whitespace.
pub fn extract_description(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => Some(
            items
                .iter()
                .filter_map(extract_description)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
        ),
        Value::Object(node) => {
            let mut parts = Vec::new();
            if let Some(text) = node.get("text").and_then(Value::as_str) {
                parts.push(text.to_owned());
            }
            if let Some(children) = node.get("content").and_then(Value::as_array) {
                parts.extend(
                    children
                        .iter()
                        .filter_map(extract_description)
                        .filter(|s| !s.is_empty()),
                );
            }
            let text = parts.join(" ");
            // JS \s includes BOM, unlike Rust's is_whitespace.
            nonempty(Some(
                text.split(js_whitespace)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "),
            ))
        }
        _ => None,
    }
}

pub fn normalize_parent_issue(raw: &Value) -> Option<ParentIssueReference> {
    let key = nonempty(string(&raw["key"]))?;
    let f = fields(raw);
    Some(ParentIssueReference {
        key,
        summary: string(&f["summary"]),
        issue_type: string(&f["issuetype"]["name"]).or_else(|| string(&f["issuetype"])),
        description: extract_description(&f["description"]),
    })
}

pub fn normalize_project(raw: &Value) -> Option<Project> {
    let key = nonempty(string(&raw["key"]))?;
    let name = nonempty(string(&raw["name"]).or_else(|| Some(key.clone())))?;
    Some(Project {
        id: string(&raw["id"]),
        key,
        name,
    })
}

fn user_name(raw: &Value) -> Option<String> {
    string(&raw["displayName"])
        .or_else(|| string(&raw["name"]))
        .or_else(|| string(&raw["key"]))
}
fn mention(raw: &Value) -> Option<String> {
    if let Some(id) = trimmed(&raw["accountId"]) {
        return Some(format!("[~accountid:{id}]"));
    }
    trimmed(&raw["name"])
        .or_else(|| trimmed(&raw["key"]))
        .map(|name| format!("[~{name}]"))
}

pub fn normalize_issue(raw: &Value, base: &str) -> Option<IssueSummary> {
    let key = nonempty(string(&raw["key"]))?;
    let f = fields(raw);
    Some(IssueSummary {
        id: string(&raw["id"]),
        browse_url: Some(derive_browse_url(base, &key)),
        key,
        summary: string(&f["summary"]).unwrap_or_else(|| "(No summary)".into()),
        status: string(&f["status"]["name"])
            .or_else(|| string(&f["status"]))
            .unwrap_or_else(|| "Unknown".into()),
        status_category: string(&f["status"]["statusCategory"]["name"]),
        issue_type: string(&f["issuetype"]["name"])
            .or_else(|| string(&f["issuetype"]))
            .unwrap_or_else(|| "Issue".into()),
        project_key: string(&f["project"]["key"]).unwrap_or_default(),
        project_name: string(&f["project"]["name"]),
        parent_key: string(&f["parent"]["key"]),
        parent_issue: normalize_parent_issue(&f["parent"]),
        assignee: user_name(&f["assignee"]),
        reporter: user_name(&f["reporter"]),
        reporter_mention: mention(&f["reporter"]),
        priority: string(&f["priority"]["name"]),
        created: string(&f["created"]),
        updated: string(&f["updated"]),
        self_url: string(&raw["self"]),
        description: extract_description(&f["description"]),
        raw: Some(raw.clone()),
        severity: None,
        reported_by: None,
        complexity: None,
        model: None,
        idea_transcript: None,
        planning_id: None,
        depends_on: None,
        branch: None,
        completed: None,
        attachments: None,
        ai_assignment: None,
        sub_tasks: None,
        child_seq: None,
        origin: None,
        source_path: None,
    })
}

pub fn normalize_transition(raw: &Value) -> Option<WorkflowTransition> {
    Some(WorkflowTransition {
        id: nonempty(string(&raw["id"]))?,
        name: nonempty(string(&raw["name"]))?,
        to_status: string(&raw["to"]["name"]),
        raw: Some(raw.clone()),
    })
}

pub fn normalize_comment(raw: &Value) -> Option<IssueComment> {
    let body = extract_description(&raw["body"]).or_else(|| string(&raw["body"]))?;
    Some(IssueComment {
        body: nonempty(Some(body.trim_matches(js_whitespace).to_owned()))?,
        id: string(&raw["id"]),
        author: string(&raw["author"]["displayName"]).or_else(|| string(&raw["author"]["name"])),
        created: string(&raw["created"]),
        updated: string(&raw["updated"]),
        raw: Some(raw.clone()),
    })
}

/// Unwrap common community and official MCP search response shapes.
pub fn extract_array<'a>(payload: &'a Value, keys: &[&str]) -> &'a [Value] {
    if let Some(items) = payload.as_array() {
        return items;
    }
    keys.iter()
        .filter_map(|key| payload.get(key).and_then(Value::as_array))
        .next()
        .or_else(|| payload.get("values").and_then(Value::as_array))
        .map_or(&[], Vec::as_slice)
}

pub fn extract_issue_key(raw: &Value) -> Option<String> {
    string(&raw["key"]).or_else(|| string(&raw["id"]))
}

pub fn status_category_rank(category: Option<&str>) -> u8 {
    match category
        .unwrap_or_default()
        .trim_matches(js_whitespace)
        .to_lowercase()
        .as_str()
    {
        "to do" | "todo" => 0,
        "in progress" | "indeterminate" => 1,
        "done" => 2,
        _ => 3,
    }
}

pub fn normalize_field_name(value: &str) -> String {
    value
        .trim_matches(js_whitespace)
        .to_lowercase()
        .split(|c: char| js_whitespace(c) || c == '_' || c == '-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn build_board_status_order(
    configured: &[String],
    workflow: &[String],
    issues: &[String],
) -> Vec<String> {
    if !configured.is_empty() {
        return configured.to_vec();
    }
    let backlog = workflow
        .iter()
        .chain(issues)
        .find(|name| normalize_field_name(name) == "backlog");
    let mut seen = HashSet::new();
    backlog
        .into_iter()
        .chain(workflow)
        .chain(issues)
        .map(|s| s.trim_matches(js_whitespace))
        .filter(|s| !s.is_empty() && seen.insert((*s).to_owned()))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests;
