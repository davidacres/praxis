//! GitLab REST client (`gitlab/gitLabApiService.ts` port), plus the merge-request helpers
//! that live beside it: remote-URL parsing, issue-key matching, discussion-note diffing and
//! the review/done status checks.
//!
//! The request machinery is public ([`GitLabApiService::send`],
//! [`GitLabApiService::build_url`], [`GitLabApiService::request_json`]) so the GitLab CI
//! evidence provider shares one client rather than growing its own. Every request carries
//! [`GITLAB_USER_AGENT`]: `reqwest` sends none by default, where Node's `fetch` did.

use std::collections::HashMap;
use std::fmt;
use std::path::Path;

use regex::Regex;
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::rest_support::{as_string, as_u64, encode_uri_component, truncate_error_detail};

pub const GITLAB_USER_AGENT: &str = "praxis";
pub const PRAXIS_MR_REPLY_MARKER: &str = "<!-- praxis-mr-reply -->";

/// Where and as whom the client talks to GitLab.
#[derive(Clone, PartialEq, Eq)]
pub struct GitLabApiConfig {
    /// The instance root, e.g. `https://gitlab.com` — request paths carry `/api/v4`.
    pub base_url: String,
    /// The default project (`group/project`); may be blank when boards span projects.
    pub project_path: String,
    pub token: String,
}

impl fmt::Debug for GitLabApiConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GitLabApiConfig")
            .field("base_url", &self.base_url)
            .field("project_path", &self.project_path)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// A failed GitLab call. The message never includes the token.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GitLabApiError {
    #[error("No GitLab project path is configured.")]
    ProjectNotConfigured,
    /// GitLab answered with a non-success status; the message carries its own error text.
    #[error("{message}")]
    Http { status: u16, message: String },
    #[error("GitLab request could not be sent: {0}")]
    Transport(String),
    #[error("GitLab returned an unreadable response: {0}")]
    InvalidResponse(String),
    #[error("Invalid GitLab URL: {0}")]
    InvalidUrl(String),
}

impl GitLabApiError {
    /// The HTTP status GitLab answered with, when it answered at all.
    #[must_use]
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl From<GitLabApiError> for String {
    fn from(error: GitLabApiError) -> Self {
        error.to_string()
    }
}

/// A project addressed by path (`group/project`) or numeric id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitLabProjectRef {
    Path(String),
    Id(u64),
}

impl From<&str> for GitLabProjectRef {
    fn from(path: &str) -> Self {
        Self::Path(path.to_string())
    }
}

impl From<u64> for GitLabProjectRef {
    fn from(id: u64) -> Self {
        Self::Id(id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabProjectRemote {
    pub base_url: String,
    pub project_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabProject {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub path_with_namespace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabUser {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitLabBoardListKind {
    Label,
    Assignee,
    Milestone,
    Iteration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabBoardList {
    pub id: u64,
    pub title: String,
    pub position: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<GitLabBoardListKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iteration_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iteration_title: Option<String>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabBoard {
    pub id: u64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub project: GitLabProject,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
    pub hide_backlog_list: bool,
    pub hide_closed_list: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone_title: Option<String>,
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<i64>,
    pub lists: Vec<GitLabBoardList>,
    pub raw: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabIssueAssignee {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabIssueReferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabIssue {
    pub id: u64,
    pub iid: u64,
    pub project_id: u64,
    pub title: String,
    /// `opened` or `closed`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    pub assignees: Vec<GitLabIssueAssignee>,
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iteration_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<GitLabIssueReferences>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabIssueComment {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabMergeRequest {
    pub project_id: u64,
    pub iid: u64,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source_branch: String,
    pub target_branch: String,
    pub state: String,
    pub web_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_commit_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabDiscussionNote {
    pub id: String,
    pub discussion_id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub system: bool,
}

/// The notes that appeared or changed since the last poll.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabDiscussionNoteDiff {
    pub new_notes: Vec<GitLabDiscussionNote>,
    pub updated_notes: Vec<GitLabDiscussionNote>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateGitLabMergeRequestInput {
    pub source_branch: String,
    pub target_branch: String,
    pub title: String,
    pub description: Option<String>,
    pub remove_source_branch: bool,
}

/// GitLab's issue state filter.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum GitLabIssueStateFilter {
    Opened,
    Closed,
    #[default]
    All,
}

impl GitLabIssueStateFilter {
    fn as_str(self) -> &'static str {
        match self {
            Self::Opened => "opened",
            Self::Closed => "closed",
            Self::All => "all",
        }
    }
}

/// The board scope an issue list is narrowed to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitLabIssueListFilters {
    pub state: GitLabIssueStateFilter,
    pub labels: Vec<String>,
    pub assignee_username: Option<String>,
    pub milestone_title: Option<String>,
    pub iteration_title: Option<String>,
    pub weight: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateGitLabIssueInput {
    pub title: String,
    pub description: Option<String>,
    pub labels: Vec<String>,
    pub assignee_ids: Vec<u64>,
}

/// GitLab's `state_event` for an issue update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitLabStateEvent {
    Close,
    Reopen,
}

impl GitLabStateEvent {
    fn as_str(self) -> &'static str {
        match self {
            Self::Close => "close",
            Self::Reopen => "reopen",
        }
    }
}

/// An issue update; `None` leaves a field alone. An empty `assignee_ids` unassigns everyone
/// and a `milestone_id` / `iteration_id` of 0 clears it, as GitLab defines.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateGitLabIssueInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub state_event: Option<GitLabStateEvent>,
    pub add_labels: Option<Vec<String>>,
    pub remove_labels: Option<Vec<String>>,
    pub assignee_ids: Option<Vec<u64>>,
    pub milestone_id: Option<u64>,
    pub iteration_id: Option<u64>,
}

/// Form fields of a request body, in send order.
pub type GitLabForm = Vec<(&'static str, String)>;

fn join_ids(ids: &[u64]) -> String {
    ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",")
}

fn push_list(form: &mut GitLabForm, key: &'static str, values: Option<&Vec<String>>) {
    if let Some(values) = values.filter(|values| !values.is_empty()) {
        form.push((key, values.join(",")));
    }
}

impl UpdateGitLabIssueInput {
    /// The `PUT` form, omitting every unset field.
    #[must_use]
    pub fn to_form(&self) -> GitLabForm {
        let mut form = GitLabForm::new();
        if let Some(title) = &self.title {
            form.push(("title", title.clone()));
        }
        if let Some(description) = &self.description {
            form.push(("description", description.clone()));
        }
        if let Some(event) = self.state_event {
            form.push(("state_event", event.as_str().to_string()));
        }
        push_list(&mut form, "add_labels", self.add_labels.as_ref());
        push_list(&mut form, "remove_labels", self.remove_labels.as_ref());
        if let Some(ids) = &self.assignee_ids {
            let value = if ids.is_empty() {
                "0".to_string()
            } else {
                join_ids(ids)
            };
            form.push(("assignee_ids", value));
        }
        if let Some(id) = self.milestone_id {
            form.push(("milestone_id", id.to_string()));
        }
        if let Some(id) = self.iteration_id {
            form.push(("iteration_id", id.to_string()));
        }
        form
    }
}

/// GitLab returns error details as `{"message": ...}`, `{"error": ...}` or
/// `{"error_description": ...}`, where `message` may be a string, an array or a nested
/// field → messages object. Surfacing the raw body floods the UI with JSON, so this extracts
/// a short message and falls back to the HTTP status when no readable detail is available.
#[must_use]
pub fn format_gitlab_error(status: u16, status_text: &str, response_text: &str) -> String {
    let status_suffix = if status_text.is_empty() {
        String::new()
    } else {
        format!(" {status_text}")
    };
    let base = format!("GitLab request failed (HTTP {status}{status_suffix})");
    match extract_gitlab_error_detail(response_text) {
        Some(detail) => format!("{base}: {detail}"),
        None => format!("{base}."),
    }
}

fn extract_gitlab_error_detail(response_text: &str) -> Option<String> {
    let trimmed = response_text.trim();
    if trimmed.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::String(text)) => return Some(truncate_error_detail(&text)),
        Ok(Value::Object(record)) => {
            let message = ["message", "error", "error_description"]
                .iter()
                .find_map(|key| record.get(*key).filter(|value| !value.is_null()));
            if let Some(flattened) = message.and_then(flatten_gitlab_message) {
                return Some(truncate_error_detail(&flattened));
            }
        }
        _ => {}
    }
    Some(truncate_error_detail(trimmed))
}

fn flatten_gitlab_message(value: &Value) -> Option<String> {
    let joined = |parts: Vec<String>| (!parts.is_empty()).then(|| parts.join("; "));
    match value {
        Value::String(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_string())
        }
        Value::Array(items) => joined(items.iter().filter_map(flatten_gitlab_message).collect()),
        Value::Object(fields) => joined(
            fields
                .iter()
                .filter_map(|(field, value)| {
                    flatten_gitlab_message(value).map(|flat| format!("{field}: {flat}"))
                })
                .collect(),
        ),
        _ => None,
    }
}

/// The instance URL and project path of a GitLab git remote — `git@host:group/project.git`
/// or any URL form.
pub fn parse_gitlab_remote_url(remote_url: &str) -> Result<GitLabProjectRemote, String> {
    static SSH: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let trimmed = remote_url.trim();
    if trimmed.is_empty() {
        return Err("The git remote URL is empty.".to_string());
    }
    let ssh = SSH.get_or_init(|| {
        Regex::new(r"(?i)^git@([^:]+):(.+?)(?:\.git)?$").expect("the SSH remote pattern is valid")
    });
    if let Some(captures) = ssh.captures(trimmed) {
        return Ok(GitLabProjectRemote {
            base_url: format!("https://{}", &captures[1]),
            project_path: captures[2].to_string(),
        });
    }
    let parsed =
        Url::parse(trimmed).map_err(|_| format!("Unsupported git remote URL format: {trimmed}"))?;
    let host = match (parsed.host_str(), parsed.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        (None, _) => String::new(),
    };
    let path = parsed.path().trim_start_matches('/');
    let path = if path.len() >= 4 && path[path.len() - 4..].eq_ignore_ascii_case(".git") {
        &path[..path.len() - 4]
    } else {
        path
    };
    Ok(GitLabProjectRemote {
        base_url: format!("{}://{host}", parsed.scheme()),
        project_path: path.to_string(),
    })
}

/// Reads `origin`'s URL in `repo_path` and parses it as a GitLab remote.
pub async fn infer_gitlab_project_from_repo(
    repo_path: &Path,
) -> Result<GitLabProjectRemote, String> {
    let mut command = tokio::process::Command::new("git");
    command
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_path)
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .await
        .map_err(|error| format!("Command failed: git remote get-url origin: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Command failed: git remote get-url origin: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_gitlab_remote_url(String::from_utf8_lossy(&output.stdout).trim())
}

/// Matches an issue key as a whole token (not inside a longer key), case-insensitively.
#[must_use]
pub fn create_issue_key_matcher(issue_key: &str) -> Regex {
    let escaped = regex::escape(&issue_key.trim().to_uppercase());
    Regex::new(&format!("(?i)(^|[^A-Z0-9]){escaped}([^A-Z0-9]|$)"))
        .expect("an escaped issue key always forms a valid pattern")
}

/// Whether the merge request's title, description or source branch names the issue key.
#[must_use]
pub fn merge_request_matches_issue_key(
    title: &str,
    description: Option<&str>,
    source_branch: &str,
    issue_key: &str,
) -> bool {
    let matcher = create_issue_key_matcher(issue_key);
    [Some(title), description, Some(source_branch)]
        .into_iter()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .any(|value| matcher.is_match(&value.to_uppercase()))
}

/// Every note of every discussion, oldest first (then by id), dropping notes without an id.
#[must_use]
pub fn flatten_gitlab_discussion_notes(discussions: &[Value]) -> Vec<GitLabDiscussionNote> {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_string);
    let mut notes: Vec<GitLabDiscussionNote> = discussions
        .iter()
        .flat_map(|discussion| {
            let discussion_id = as_string(discussion.get("id")).unwrap_or_default();
            discussion
                .get("notes")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .map(move |entry| {
                    let author = entry.get("author");
                    let created_at = text(entry.get("created_at"));
                    GitLabDiscussionNote {
                        id: as_string(entry.get("id")).unwrap_or_default(),
                        discussion_id: discussion_id.clone(),
                        author: text(author.and_then(|a| a.get("username")))
                            .or_else(|| text(author.and_then(|a| a.get("name"))))
                            .unwrap_or_else(|| "unknown".to_string()),
                        body: text(entry.get("body")).unwrap_or_default(),
                        updated_at: text(entry.get("updated_at"))
                            .or_else(|| created_at.clone())
                            .unwrap_or_default(),
                        created_at: created_at.unwrap_or_default(),
                        system: entry.get("system") == Some(&Value::Bool(true)),
                    }
                })
        })
        .filter(|note| !note.id.is_empty())
        .collect();
    notes.sort_by(|left, right| {
        crate::rest_support::locale_compare(&left.created_at, &right.created_at)
            .then_with(|| left.id.to_lowercase().cmp(&right.id.to_lowercase()))
    });
    notes
}

/// Note id → its `updated_at`, the state [`diff_gitlab_discussion_notes`] compares against.
#[must_use]
pub fn create_gitlab_handled_note_state(notes: &[GitLabDiscussionNote]) -> HashMap<String, String> {
    notes
        .iter()
        .map(|note| (note.id.clone(), note.updated_at.clone()))
        .collect()
}

/// The notes new or edited since `previous_notes`; a baseline poll reports nothing.
#[must_use]
pub fn diff_gitlab_discussion_notes(
    previous_notes: Option<&HashMap<String, String>>,
    current_notes: &[GitLabDiscussionNote],
    is_baseline: bool,
) -> GitLabDiscussionNoteDiff {
    let mut diff = GitLabDiscussionNoteDiff::default();
    if is_baseline {
        return diff;
    }
    for note in current_notes {
        match previous_notes
            .and_then(|state| state.get(&note.id))
            .filter(|updated| !updated.is_empty())
        {
            None => diff.new_notes.push(note.clone()),
            Some(previous) if *previous != note.updated_at => {
                diff.updated_notes.push(note.clone());
            }
            Some(_) => {}
        }
    }
    diff
}

#[must_use]
pub fn is_praxis_managed_merge_request_note(body: &str) -> bool {
    body.trim_start().starts_with(PRAXIS_MR_REPLY_MARKER)
}

#[must_use]
pub fn wrap_praxis_managed_merge_request_note(body: &str) -> String {
    format!("{PRAXIS_MR_REPLY_MARKER}\n{}", body.trim())
}

#[must_use]
pub fn is_done_like_status(status: Option<&str>, status_category: Option<&str>) -> bool {
    let status = status.unwrap_or_default().trim().to_lowercase();
    let category = status_category.unwrap_or_default().trim().to_lowercase();
    category == "done" || matches!(status.as_str(), "done" | "closed" | "resolved")
}

#[must_use]
pub fn is_in_review_like_status(status: Option<&str>) -> bool {
    matches!(
        status.unwrap_or_default().trim().to_lowercase().as_str(),
        "in review" | "review"
    )
}

/// A card moving from review to done is the cue to open a merge request.
#[must_use]
pub fn should_create_merge_request_for_status_change(
    previous_status: Option<&str>,
    current_status: Option<&str>,
    current_status_category: Option<&str>,
) -> bool {
    is_in_review_like_status(previous_status)
        && is_done_like_status(current_status, current_status_category)
}

fn object(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.is_object())
}

fn str_field(raw: &Value, key: &str) -> Option<String> {
    raw.get(key).and_then(Value::as_str).map(str::to_string)
}

/// `toOptionalNumber`: a number, or a numeric string.
fn optional_id(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64(),
        Value::String(text) if !text.trim().is_empty() => text.trim().parse().ok(),
        _ => None,
    }
}

fn as_i64(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn normalize_merge_request(raw: &Value) -> GitLabMergeRequest {
    GitLabMergeRequest {
        project_id: as_u64(raw.get("project_id")),
        iid: as_u64(raw.get("iid")),
        title: as_string(raw.get("title")).unwrap_or_default(),
        description: as_string(raw.get("description")),
        source_branch: as_string(raw.get("source_branch")).unwrap_or_default(),
        target_branch: as_string(raw.get("target_branch")).unwrap_or_default(),
        state: as_string(raw.get("state")).unwrap_or_default(),
        web_url: as_string(raw.get("web_url")).unwrap_or_default(),
        created_at: str_field(raw, "created_at"),
        updated_at: str_field(raw, "updated_at"),
        merge_commit_sha: str_field(raw, "merge_commit_sha"),
        head_sha: as_string(raw.get("sha"))
            .or_else(|| object(raw.get("diff_refs")).and_then(|refs| str_field(refs, "head_sha"))),
    }
}

fn normalize_project(raw: &Value) -> GitLabProject {
    GitLabProject {
        id: as_u64(raw.get("id")),
        name: as_string(raw.get("name")).unwrap_or_default(),
        path: as_string(raw.get("path")).unwrap_or_default(),
        path_with_namespace: as_string(raw.get("path_with_namespace"))
            .or_else(|| as_string(raw.get("path")))
            .unwrap_or_default(),
        web_url: as_string(raw.get("web_url")),
    }
}

fn normalize_user(raw: &Value) -> GitLabUser {
    GitLabUser {
        id: as_u64(raw.get("id")),
        username: as_string(raw.get("username")),
        name: as_string(raw.get("name")),
        state: as_string(raw.get("state")),
    }
}

fn normalize_board_list(raw: &Value) -> GitLabBoardList {
    let label = object(raw.get("label"));
    let assignee = object(raw.get("assignee"));
    let milestone = object(raw.get("milestone"));
    let iteration = object(raw.get("iteration"));
    let field = |record: Option<&Value>, key: &str| as_string(record.and_then(|r| r.get(key)));

    let kind = if label.is_some() {
        Some(GitLabBoardListKind::Label)
    } else if assignee.is_some() {
        Some(GitLabBoardListKind::Assignee)
    } else if milestone.is_some() {
        Some(GitLabBoardListKind::Milestone)
    } else if iteration.is_some() {
        Some(GitLabBoardListKind::Iteration)
    } else {
        None
    };
    let title = field(label, "name")
        .or_else(|| field(assignee, "name"))
        .or_else(|| field(milestone, "title"))
        .or_else(|| field(iteration, "title"))
        .or_else(|| as_string(raw.get("list_type")))
        .unwrap_or_else(|| {
            let id = match raw.get("id") {
                Some(Value::Number(number)) => number.to_string(),
                Some(Value::String(text)) => text.clone(),
                _ => "unknown".to_string(),
            };
            format!("List {id}")
        });

    GitLabBoardList {
        id: as_u64(raw.get("id")),
        title,
        position: as_i64(raw.get("position")),
        kind,
        label_name: field(label, "name"),
        assignee_id: optional_id(assignee.and_then(|a| a.get("id"))),
        assignee_username: field(assignee, "username"),
        milestone_id: optional_id(milestone.and_then(|m| m.get("id"))),
        milestone_title: field(milestone, "title"),
        iteration_id: optional_id(iteration.and_then(|i| i.get("id"))),
        iteration_title: field(iteration, "title"),
        raw: raw.clone(),
    }
}

fn normalize_board_lists(raw: &[Value]) -> Vec<GitLabBoardList> {
    let mut lists: Vec<GitLabBoardList> = raw.iter().map(normalize_board_list).collect();
    lists.sort_by_key(|list| list.position);
    lists
}

fn normalize_board(raw: Value) -> GitLabBoard {
    let empty = Value::Object(Map::new());
    let project = object(raw.get("project")).unwrap_or(&empty);
    let creator = object(raw.get("creator")).or_else(|| object(raw.get("author")));
    let labels = raw
        .get("labels")
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .filter_map(|label| match label {
                    Value::String(name) => Some(name.clone()),
                    other => as_string(other.get("name")),
                })
                .filter(|label| !label.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    let lists = raw
        .get("lists")
        .and_then(Value::as_array)
        .map(|lists| normalize_board_lists(lists))
        .unwrap_or_default();
    GitLabBoard {
        id: as_u64(raw.get("id")),
        name: as_string(raw.get("name")).unwrap_or_default(),
        created_by: creator
            .and_then(|c| as_string(c.get("name")).or_else(|| as_string(c.get("username")))),
        created_at: as_string(raw.get("created_at")),
        project: normalize_project(project),
        web_url: as_string(raw.get("web_url")).or_else(|| as_string(project.get("web_url"))),
        hide_backlog_list: raw.get("hide_backlog_list") == Some(&Value::Bool(true)),
        hide_closed_list: raw.get("hide_closed_list") == Some(&Value::Bool(true)),
        assignee_username: object(raw.get("assignee")).and_then(|a| as_string(a.get("username"))),
        milestone_title: object(raw.get("milestone")).and_then(|m| as_string(m.get("title"))),
        labels,
        weight: raw.get("weight").and_then(Value::as_i64),
        lists,
        raw,
    }
}

fn normalize_issue(raw: Value) -> GitLabIssue {
    let assignees = raw
        .get("assignees")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|assignee| GitLabIssueAssignee {
                    username: as_string(assignee.get("username")),
                    name: as_string(assignee.get("name")),
                })
                .collect()
        })
        .unwrap_or_default();
    let labels = raw
        .get("labels")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|label| as_string(Some(label)))
                .filter(|label| !label.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    let author = object(raw.get("author"));
    GitLabIssue {
        id: as_u64(raw.get("id")),
        iid: as_u64(raw.get("iid")),
        project_id: as_u64(raw.get("project_id")),
        title: as_string(raw.get("title")).unwrap_or_default(),
        state: as_string(raw.get("state")).unwrap_or_default(),
        web_url: as_string(raw.get("web_url")),
        author_name: author
            .and_then(|a| as_string(a.get("name")).or_else(|| as_string(a.get("username")))),
        assignees,
        labels,
        milestone_title: object(raw.get("milestone")).and_then(|m| as_string(m.get("title"))),
        iteration_title: object(raw.get("iteration")).and_then(|i| as_string(i.get("title"))),
        created_at: as_string(raw.get("created_at")),
        updated_at: as_string(raw.get("updated_at")),
        description: as_string(raw.get("description")),
        references: object(raw.get("references")).map(|refs| GitLabIssueReferences {
            full: as_string(refs.get("full")),
            relative: as_string(refs.get("relative")),
            short: as_string(refs.get("short")),
        }),
        raw,
    }
}

fn normalize_issue_comment(raw: Value) -> GitLabIssueComment {
    let author = object(raw.get("author"));
    GitLabIssueComment {
        id: as_string(raw.get("id")).unwrap_or_default(),
        author: author
            .and_then(|a| as_string(a.get("name")).or_else(|| as_string(a.get("username")))),
        body: as_string(raw.get("body")).unwrap_or_default(),
        created_at: as_string(raw.get("created_at")),
        updated_at: as_string(raw.get("updated_at")),
        raw,
    }
}

fn into_array(value: Value) -> Result<Vec<Value>, GitLabApiError> {
    match value {
        Value::Array(items) => Ok(items),
        _ => Err(GitLabApiError::InvalidResponse(
            "expected a JSON array for a list endpoint".to_string(),
        )),
    }
}

/// A JSON response body plus GitLab's `x-next-page`, if any.
#[derive(Debug, Clone, PartialEq)]
pub struct GitLabJsonPage {
    pub data: Value,
    pub next_page: Option<String>,
}

/// GitLab's REST API v4 for one instance and default project.
#[derive(Debug, Clone)]
pub struct GitLabApiService {
    config: GitLabApiConfig,
    client: Client,
}

impl GitLabApiService {
    #[must_use]
    pub fn new(config: GitLabApiConfig) -> Self {
        Self::with_client(config, Client::new())
    }

    /// Shares an existing connection pool.
    #[must_use]
    pub fn with_client(config: GitLabApiConfig, client: Client) -> Self {
        Self { config, client }
    }

    #[must_use]
    pub fn config(&self) -> &GitLabApiConfig {
        &self.config
    }

    fn project_path(
        &self,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<String, GitLabApiError> {
        Ok(format!(
            "/api/v4/projects/{}",
            self.encode_project_ref(project_ref)?
        ))
    }

    pub async fn list_merge_requests_for_issue(
        &self,
        issue_key: &str,
    ) -> Result<Vec<GitLabMergeRequest>, GitLabApiError> {
        let path = format!("{}/merge_requests", self.project_path(None)?);
        let raw = self
            .request_json(
                Method::GET,
                &path,
                &[
                    ("state", "all"),
                    ("scope", "all"),
                    ("search", issue_key),
                    ("per_page", "100"),
                    ("order_by", "updated_at"),
                    ("sort", "desc"),
                ],
                None,
            )
            .await?;
        Ok(into_array(raw)?
            .iter()
            .map(normalize_merge_request)
            .filter(|mr| {
                merge_request_matches_issue_key(
                    &mr.title,
                    mr.description.as_deref(),
                    &mr.source_branch,
                    issue_key,
                )
            })
            .collect())
    }

    pub async fn get_project(
        &self,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<GitLabProject, GitLabApiError> {
        let path = self.project_path(project_ref)?;
        let project = self.request_json(Method::GET, &path, &[], None).await?;
        Ok(normalize_project(&project))
    }

    pub async fn get_current_user(&self) -> Result<GitLabUser, GitLabApiError> {
        let user = self
            .request_json(Method::GET, "/api/v4/user", &[], None)
            .await?;
        Ok(normalize_user(&user))
    }

    /// An exact username match first; failing that, a fuzzy search.
    pub async fn find_users(&self, search_text: &str) -> Result<Vec<GitLabUser>, GitLabApiError> {
        let trimmed = search_text.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let exact = into_array(
            self.request_json(
                Method::GET,
                "/api/v4/users",
                &[("username", trimmed), ("active", "true")],
                None,
            )
            .await?,
        )?;
        if !exact.is_empty() {
            return Ok(exact.iter().map(normalize_user).collect());
        }
        let matching = into_array(
            self.request_json(
                Method::GET,
                "/api/v4/users",
                &[("search", trimmed), ("active", "true"), ("per_page", "100")],
                None,
            )
            .await?,
        )?;
        Ok(matching.iter().map(normalize_user).collect())
    }

    pub async fn list_accessible_projects(
        &self,
        search_text: Option<&str>,
    ) -> Result<Vec<GitLabProject>, GitLabApiError> {
        let projects = self
            .request_json_paginated(
                "/api/v4/projects",
                &[
                    ("membership", "true"),
                    ("simple", "true"),
                    ("archived", "false"),
                    ("order_by", "last_activity_at"),
                    ("sort", "desc"),
                    ("search", search_text.map(str::trim).unwrap_or_default()),
                ],
            )
            .await?;
        Ok(projects.iter().map(normalize_project).collect())
    }

    pub async fn list_boards(
        &self,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<Vec<GitLabBoard>, GitLabApiError> {
        let path = format!("{}/boards", self.project_path(project_ref)?);
        let boards = into_array(self.request_json(Method::GET, &path, &[], None).await?)?;
        Ok(boards.into_iter().map(normalize_board).collect())
    }

    pub async fn get_board(
        &self,
        board_id: u64,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<GitLabBoard, GitLabApiError> {
        let path = format!("{}/boards/{board_id}", self.project_path(project_ref)?);
        let board = self.request_json(Method::GET, &path, &[], None).await?;
        Ok(normalize_board(board))
    }

    pub async fn list_board_lists(
        &self,
        board_id: u64,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<Vec<GitLabBoardList>, GitLabApiError> {
        let path = format!(
            "{}/boards/{board_id}/lists",
            self.project_path(project_ref)?
        );
        let lists = into_array(self.request_json(Method::GET, &path, &[], None).await?)?;
        Ok(normalize_board_lists(&lists))
    }

    pub async fn list_issues(
        &self,
        project_ref: Option<&GitLabProjectRef>,
        filters: &GitLabIssueListFilters,
    ) -> Result<Vec<GitLabIssue>, GitLabApiError> {
        let path = format!("{}/issues", self.project_path(project_ref)?);
        let labels = filters.labels.join(",");
        let weight = filters.weight.map(|w| w.to_string()).unwrap_or_default();
        let issues = self
            .request_json_paginated(
                &path,
                &[
                    ("scope", "all"),
                    ("state", filters.state.as_str()),
                    ("labels", &labels),
                    (
                        "assignee_username",
                        filters.assignee_username.as_deref().unwrap_or_default(),
                    ),
                    (
                        "milestone",
                        filters.milestone_title.as_deref().unwrap_or_default(),
                    ),
                    (
                        "iteration_title",
                        filters.iteration_title.as_deref().unwrap_or_default(),
                    ),
                    ("weight", &weight),
                    ("with_labels_details", "false"),
                    ("order_by", "updated_at"),
                    ("sort", "desc"),
                ],
            )
            .await?;
        Ok(issues.into_iter().map(normalize_issue).collect())
    }

    pub async fn get_issue(
        &self,
        issue_iid: u64,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<GitLabIssue, GitLabApiError> {
        let path = format!("{}/issues/{issue_iid}", self.project_path(project_ref)?);
        let issue = self.request_json(Method::GET, &path, &[], None).await?;
        Ok(normalize_issue(issue))
    }

    /// The first 100 notes, oldest first.
    pub async fn list_issue_comments(
        &self,
        issue_iid: u64,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<Vec<GitLabIssueComment>, GitLabApiError> {
        let path = format!(
            "{}/issues/{issue_iid}/notes",
            self.project_path(project_ref)?
        );
        let notes = into_array(
            self.request_json(
                Method::GET,
                &path,
                &[
                    ("sort", "asc"),
                    ("order_by", "created_at"),
                    ("per_page", "100"),
                ],
                None,
            )
            .await?,
        )?;
        Ok(notes.into_iter().map(normalize_issue_comment).collect())
    }

    pub async fn add_issue_comment(
        &self,
        issue_iid: u64,
        body: &str,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<(), GitLabApiError> {
        let path = format!(
            "{}/issues/{issue_iid}/notes",
            self.project_path(project_ref)?
        );
        self.request_json(
            Method::POST,
            &path,
            &[],
            Some(&vec![("body", body.trim().to_string())]),
        )
        .await?;
        Ok(())
    }

    pub async fn create_issue(
        &self,
        input: &CreateGitLabIssueInput,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<GitLabIssue, GitLabApiError> {
        let path = format!("{}/issues", self.project_path(project_ref)?);
        let mut form: GitLabForm = vec![("title", input.title.clone())];
        if let Some(description) = &input.description {
            form.push(("description", description.clone()));
        }
        push_list(&mut form, "labels", Some(&input.labels));
        if !input.assignee_ids.is_empty() {
            form.push(("assignee_ids", join_ids(&input.assignee_ids)));
        }
        let issue = self
            .request_json(Method::POST, &path, &[], Some(&form))
            .await?;
        Ok(normalize_issue(issue))
    }

    pub async fn update_issue(
        &self,
        issue_iid: u64,
        input: &UpdateGitLabIssueInput,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<GitLabIssue, GitLabApiError> {
        let path = format!("{}/issues/{issue_iid}", self.project_path(project_ref)?);
        let issue = self
            .request_json(Method::PUT, &path, &[], Some(&input.to_form()))
            .await?;
        Ok(normalize_issue(issue))
    }

    pub async fn list_merge_requests_for_source_branch(
        &self,
        source_branch: &str,
    ) -> Result<Vec<GitLabMergeRequest>, GitLabApiError> {
        let path = format!("{}/merge_requests", self.project_path(None)?);
        let raw = self
            .request_json(
                Method::GET,
                &path,
                &[
                    ("state", "all"),
                    ("scope", "all"),
                    ("source_branch", source_branch),
                    ("per_page", "100"),
                    ("order_by", "updated_at"),
                    ("sort", "desc"),
                ],
                None,
            )
            .await?;
        Ok(into_array(raw)?
            .iter()
            .map(normalize_merge_request)
            .collect())
    }

    pub async fn get_merge_request(&self, iid: u64) -> Result<GitLabMergeRequest, GitLabApiError> {
        let path = format!("{}/merge_requests/{iid}", self.project_path(None)?);
        let raw = self.request_json(Method::GET, &path, &[], None).await?;
        Ok(normalize_merge_request(&raw))
    }

    pub async fn create_merge_request(
        &self,
        input: &CreateGitLabMergeRequestInput,
    ) -> Result<GitLabMergeRequest, GitLabApiError> {
        let path = format!("{}/merge_requests", self.project_path(None)?);
        let form: GitLabForm = vec![
            ("source_branch", input.source_branch.clone()),
            ("target_branch", input.target_branch.clone()),
            ("title", input.title.clone()),
            ("description", input.description.clone().unwrap_or_default()),
            (
                "remove_source_branch",
                input.remove_source_branch.to_string(),
            ),
        ];
        let raw = self
            .request_json(Method::POST, &path, &[], Some(&form))
            .await?;
        Ok(normalize_merge_request(&raw))
    }

    pub async fn list_merge_request_discussions(
        &self,
        iid: u64,
    ) -> Result<Vec<GitLabDiscussionNote>, GitLabApiError> {
        let path = format!(
            "{}/merge_requests/{iid}/discussions",
            self.project_path(None)?
        );
        let raw = self
            .request_json(Method::GET, &path, &[("per_page", "100")], None)
            .await?;
        Ok(flatten_gitlab_discussion_notes(&into_array(raw)?))
    }

    pub async fn add_merge_request_note(&self, iid: u64, body: &str) -> Result<(), GitLabApiError> {
        let path = format!("{}/merge_requests/{iid}/notes", self.project_path(None)?);
        self.request_json(
            Method::POST,
            &path,
            &[],
            Some(&vec![("body", body.trim().to_string())]),
        )
        .await?;
        Ok(())
    }

    pub async fn reply_to_merge_request_discussion(
        &self,
        iid: u64,
        discussion_id: &str,
        body: &str,
    ) -> Result<(), GitLabApiError> {
        let path = format!(
            "{}/merge_requests/{iid}/discussions/{}/notes",
            self.project_path(None)?,
            encode_uri_component(discussion_id)
        );
        self.request_json(
            Method::POST,
            &path,
            &[],
            Some(&vec![("body", body.trim().to_string())]),
        )
        .await?;
        Ok(())
    }

    /// A numeric id as-is, else the (default) project path URI-encoded; fails before any
    /// request when the path is blank.
    pub fn encode_project_ref(
        &self,
        project_ref: Option<&GitLabProjectRef>,
    ) -> Result<String, GitLabApiError> {
        let path = match project_ref {
            Some(GitLabProjectRef::Id(id)) => return Ok(id.to_string()),
            Some(GitLabProjectRef::Path(path)) => path.as_str(),
            None => self.config.project_path.as_str(),
        };
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(GitLabApiError::ProjectNotConfigured);
        }
        Ok(encode_uri_component(trimmed))
    }

    /// `base_url` (trailing slashes dropped) + `pathname`, with every non-empty query value set.
    pub fn build_url(&self, pathname: &str, query: &[(&str, &str)]) -> Result<Url, GitLabApiError> {
        let raw = format!("{}{pathname}", self.config.base_url.trim_end_matches('/'));
        let mut url =
            Url::parse(&raw).map_err(|error| GitLabApiError::InvalidUrl(error.to_string()))?;
        let mut present = query
            .iter()
            .filter(|(_, value)| !value.is_empty())
            .peekable();
        if present.peek().is_some() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in present {
                pairs.append_pair(key, value);
            }
        }
        Ok(url)
    }

    /// One JSON request against a path under the base URL. An empty body reads as `[]`.
    pub async fn request_json(
        &self,
        method: Method,
        pathname: &str,
        query: &[(&str, &str)],
        form: Option<&GitLabForm>,
    ) -> Result<Value, GitLabApiError> {
        let url = self.build_url(pathname, query)?;
        Ok(self.request_json_page(method, url, form).await?.data)
    }

    /// Every page of a list endpoint (100 per page), following `x-next-page`.
    pub async fn request_json_paginated(
        &self,
        pathname: &str,
        query: &[(&str, &str)],
    ) -> Result<Vec<Value>, GitLabApiError> {
        let mut results = Vec::new();
        let mut next_page = Some("1".to_string());
        while let Some(page) = next_page.take() {
            let mut paged: Vec<(&str, &str)> = query
                .iter()
                .copied()
                .filter(|(key, _)| *key != "per_page" && *key != "page")
                .collect();
            paged.push(("per_page", "100"));
            paged.push(("page", &page));
            let url = self.build_url(pathname, &paged)?;
            let response = self.request_json_page(Method::GET, url, None).await?;
            results.extend(into_array(response.data)?);
            next_page = response.next_page;
        }
        Ok(results)
    }

    /// Sends one request with GitLab's headers and returns the response whatever its status,
    /// for callers that read non-JSON bodies or map statuses to their own messages. A form
    /// body is sent `application/x-www-form-urlencoded`.
    pub async fn send(
        &self,
        method: Method,
        url: Url,
        form: Option<&GitLabForm>,
    ) -> Result<reqwest::Response, GitLabApiError> {
        let mut request = self
            .client
            .request(method, url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::USER_AGENT, GITLAB_USER_AGENT)
            .header("PRIVATE-TOKEN", &self.config.token);
        request = match form {
            Some(form) => request.form(form),
            None => request.header(reqwest::header::CONTENT_TYPE, "application/json"),
        };
        request.send().await.map_err(transport_error)
    }

    /// One JSON request against an absolute URL, returning `x-next-page` too.
    pub async fn request_json_page(
        &self,
        method: Method,
        url: Url,
        form: Option<&GitLabForm>,
    ) -> Result<GitLabJsonPage, GitLabApiError> {
        let response = self.send(method, url, form).await?;
        let status = response.status();
        let next_page = next_page_header(response.headers());
        let text = response.text().await.map_err(transport_error)?;
        if !status.is_success() {
            return Err(GitLabApiError::Http {
                status: status.as_u16(),
                message: format_gitlab_error(
                    status.as_u16(),
                    status.canonical_reason().unwrap_or_default(),
                    &text,
                ),
            });
        }
        let data = if text.trim().is_empty() {
            Value::Array(Vec::new())
        } else {
            serde_json::from_str(&text)
                .map_err(|error| GitLabApiError::InvalidResponse(error.to_string()))?
        };
        Ok(GitLabJsonPage { data, next_page })
    }
}

/// GitLab's `x-next-page` header, trimmed; `None` when absent or blank (the last page).
#[must_use]
pub fn next_page_header(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get("x-next-page")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|page| !page.is_empty())
        .map(str::to_string)
}

pub(crate) fn transport_error(error: reqwest::Error) -> GitLabApiError {
    GitLabApiError::Transport(error.without_url().to_string())
}

#[cfg(test)]
mod tests;
