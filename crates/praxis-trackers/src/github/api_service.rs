//! GitHub REST client (`github/githubApiService.ts` port).
//!
//! Besides the issue/label/comment calls the board service needs, the request machinery is
//! public ([`GitHubApiService::request_json`], [`GitHubApiService::request_json_paginated`],
//! [`GitHubApiService::repo_path`]) so other GitHub features — Actions dispatch and run
//! observation — reuse one client rather than growing their own.
//!
//! Unlike Node's `fetch`, `reqwest` sends no `User-Agent` by default and GitHub rejects
//! requests without one, so every request carries [`GITHUB_USER_AGENT`].

use std::fmt;
use std::sync::OnceLock;

use regex::Regex;
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const GITHUB_API_VERSION: &str = "2022-11-28";
pub const DEFAULT_GITHUB_API_URL: &str = "https://api.github.com";
pub const GITHUB_USER_AGENT: &str = "praxis";

const MAX_ERROR_DETAIL_CHARS: usize = 200;

/// Where and as whom the client talks to GitHub.
#[derive(Clone, PartialEq, Eq)]
pub struct GitHubApiConfig {
    /// `https://api.github.com` for github.com, or a GitHub Enterprise Server API host.
    pub base_url: String,
    pub owner: String,
    pub repo: String,
    pub token: String,
}

impl fmt::Debug for GitHubApiConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GitHubApiConfig")
            .field("base_url", &self.base_url)
            .field("owner", &self.owner)
            .field("repo", &self.repo)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// A failed GitHub call. The message never includes the token.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GitHubApiError {
    #[error("No GitHub repository is configured.")]
    RepositoryNotConfigured,
    /// GitHub answered with a non-success status; the message carries its own error text.
    #[error("{message}")]
    Http { status: u16, message: String },
    #[error("GitHub request could not be sent: {0}")]
    Transport(String),
    #[error("GitHub returned an unreadable response: {0}")]
    InvalidResponse(String),
    #[error("GitHub did not return a valid authenticated user.")]
    InvalidUser,
    #[error("Invalid GitHub API URL: {0}")]
    InvalidUrl(String),
}

impl GitHubApiError {
    /// The HTTP status GitHub answered with, when it answered at all.
    #[must_use]
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl From<GitHubApiError> for String {
    fn from(error: GitHubApiError) -> Self {
        error.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubUser {
    pub login: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubLabel {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssue {
    pub id: u64,
    pub number: u64,
    pub title: String,
    /// `open` or `closed` — GitHub's only native state.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_login: Option<String>,
    pub assignees: Vec<GitHubUser>,
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// True for a pull request returned by the issues endpoint — filtered out by callers.
    pub is_pull_request: bool,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssueComment {
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
pub struct GitHubRepo {
    pub full_name: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
    pub private: bool,
}

/// GitHub's native issue state, as the update call sets it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitHubIssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CreateGitHubIssueInput {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignees: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct UpdateGitHubIssueInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<GitHubIssueState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignees: Option<Vec<String>>,
}

/// `String(value)` for a string, number or boolean; `None` for anything else.
pub(crate) fn as_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn as_number(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// `encodeURIComponent`: escapes everything but `A–Z a–z 0–9 - _ . ! ~ * ' ( )`.
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// GitHub returns `{"message": "...", "errors": [{resource, field, code, message}]}` for
/// validation failures and a plain `{"message": "..."}` for everything else; this keeps the
/// UI message short rather than surfacing the raw body.
#[must_use]
pub fn format_github_error(status: u16, status_text: &str, response_text: &str) -> String {
    let status_suffix = if status_text.is_empty() {
        String::new()
    } else {
        format!(" {status_text}")
    };
    let base = format!("GitHub request failed (HTTP {status}{status_suffix})");
    match extract_github_error_detail(response_text) {
        Some(detail) => format!("{base}: {detail}"),
        None => format!("{base}."),
    }
}

fn extract_github_error_detail(response_text: &str) -> Option<String> {
    let trimmed = response_text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(Value::Object(record)) = serde_json::from_str::<Value>(trimmed) {
        let mut parts = Vec::new();
        if let Some(message) = as_string(record.get("message")).filter(|m| !m.is_empty()) {
            parts.push(message);
        }
        if let Some(Value::Array(errors)) = record.get("errors") {
            for entry in errors.iter().filter_map(Value::as_object) {
                let field = as_string(entry.get("field")).filter(|f| !f.is_empty());
                let detail = as_string(entry.get("message"))
                    .or_else(|| as_string(entry.get("code")))
                    .filter(|d| !d.is_empty());
                match (field, detail) {
                    (Some(field), Some(detail)) => parts.push(format!("{field}: {detail}")),
                    (None, Some(detail)) => parts.push(detail),
                    _ => {}
                }
            }
        }
        if !parts.is_empty() {
            return Some(truncate_error_detail(&parts.join("; ")));
        }
    }
    Some(truncate_error_detail(trimmed))
}

fn truncate_error_detail(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() > MAX_ERROR_DETAIL_CHARS {
        let head: String = normalized
            .chars()
            .take(MAX_ERROR_DETAIL_CHARS - 1)
            .collect();
        format!("{head}…")
    } else {
        normalized
    }
}

fn normalize_user(raw: Option<&Value>) -> Option<GitHubUser> {
    let raw = raw?.as_object()?;
    let login = as_string(raw.get("login")).filter(|login| !login.is_empty())?;
    Some(GitHubUser {
        login,
        name: as_string(raw.get("name")),
    })
}

fn normalize_issue(raw: Value) -> GitHubIssue {
    let assignees = raw
        .get("assignees")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| normalize_user(Some(a)))
                .collect()
        })
        .unwrap_or_default();
    let labels = raw
        .get("labels")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|label| match label {
                    Value::String(name) => Some(name.clone()),
                    other => as_string(other.get("name")),
                })
                .filter(|label| !label.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    GitHubIssue {
        id: as_number(raw.get("id")),
        number: as_number(raw.get("number")),
        title: as_string(raw.get("title")).unwrap_or_default(),
        state: as_string(raw.get("state")).unwrap_or_else(|| "open".to_string()),
        html_url: as_string(raw.get("html_url")),
        author_login: normalize_user(raw.get("user")).map(|user| user.login),
        assignees,
        labels,
        created_at: as_string(raw.get("created_at")),
        updated_at: as_string(raw.get("updated_at")),
        closed_at: as_string(raw.get("closed_at")),
        body: as_string(raw.get("body")),
        is_pull_request: raw
            .as_object()
            .is_some_and(|record| record.contains_key("pull_request")),
        raw,
    }
}

fn normalize_issue_comment(raw: Value) -> GitHubIssueComment {
    let author = normalize_user(raw.get("user")).map(|user| user.name.unwrap_or(user.login));
    GitHubIssueComment {
        id: as_string(raw.get("id")).unwrap_or_default(),
        author,
        body: as_string(raw.get("body")).unwrap_or_default(),
        created_at: as_string(raw.get("created_at")),
        updated_at: as_string(raw.get("updated_at")),
        raw,
    }
}

fn normalize_label(raw: &Value) -> GitHubLabel {
    GitHubLabel {
        name: as_string(raw.get("name")).unwrap_or_default(),
        color: as_string(raw.get("color")),
        description: as_string(raw.get("description")),
    }
}

fn normalize_repo(raw: &Value) -> GitHubRepo {
    GitHubRepo {
        full_name: as_string(raw.get("full_name")).unwrap_or_default(),
        name: as_string(raw.get("name")).unwrap_or_default(),
        html_url: as_string(raw.get("html_url")),
        private: raw.get("private") == Some(&Value::Bool(true)),
    }
}

/// The `rel="next"` URL from GitHub's `Link` pagination header, e.g.
/// `<https://api.github.com/...&page=2>; rel="next", <...>; rel="last"`.
#[must_use]
pub fn parse_github_next_link(link_header: Option<&str>) -> Option<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r#"<([^>]+)>;\s*rel="next""#).expect("the Link header pattern is valid")
    });
    link_header?
        .split(',')
        .find_map(|part| pattern.captures(part.trim()))
        .and_then(|captures| captures.get(1))
        .map(|url| url.as_str().to_string())
}

/// A JSON response body plus the next page's URL, if any.
#[derive(Debug, Clone, PartialEq)]
pub struct GitHubJsonPage {
    pub data: Value,
    pub next_url: Option<String>,
}

/// One repository's GitHub REST API.
#[derive(Debug, Clone)]
pub struct GitHubApiService {
    config: GitHubApiConfig,
    client: Client,
}

impl GitHubApiService {
    #[must_use]
    pub fn new(config: GitHubApiConfig) -> Self {
        Self::with_client(config, Client::new())
    }

    /// Shares an existing connection pool.
    #[must_use]
    pub fn with_client(config: GitHubApiConfig, client: Client) -> Self {
        Self { config, client }
    }

    #[must_use]
    pub fn config(&self) -> &GitHubApiConfig {
        &self.config
    }

    pub async fn get_repo(&self) -> Result<GitHubRepo, GitHubApiError> {
        let repo = self
            .request_json(Method::GET, &self.repo_path()?, None)
            .await?;
        Ok(normalize_repo(&repo))
    }

    pub async fn get_current_user(&self) -> Result<GitHubUser, GitHubApiError> {
        let user = self.request_json(Method::GET, "/user", None).await?;
        normalize_user(Some(&user)).ok_or(GitHubApiError::InvalidUser)
    }

    pub async fn list_labels(&self) -> Result<Vec<GitHubLabel>, GitHubApiError> {
        let path = format!("{}/labels", self.repo_path()?);
        let labels = self.request_json_paginated(&path, &[]).await?;
        Ok(labels.iter().map(normalize_label).collect())
    }

    /// All issues (open and closed), pull requests filtered out.
    pub async fn list_issues(&self) -> Result<Vec<GitHubIssue>, GitHubApiError> {
        let path = format!("{}/issues", self.repo_path()?);
        let raw = self
            .request_json_paginated(
                &path,
                &[("state", "all"), ("sort", "updated"), ("direction", "desc")],
            )
            .await?;
        Ok(raw
            .into_iter()
            .map(normalize_issue)
            .filter(|issue| !issue.is_pull_request)
            .collect())
    }

    pub async fn get_issue(&self, issue_number: u64) -> Result<GitHubIssue, GitHubApiError> {
        let path = format!("{}/issues/{issue_number}", self.repo_path()?);
        let issue = self.request_json(Method::GET, &path, None).await?;
        Ok(normalize_issue(issue))
    }

    pub async fn create_issue(
        &self,
        input: &CreateGitHubIssueInput,
    ) -> Result<GitHubIssue, GitHubApiError> {
        let path = format!("{}/issues", self.repo_path()?);
        let body = to_body(input)?;
        let issue = self.request_json(Method::POST, &path, Some(&body)).await?;
        Ok(normalize_issue(issue))
    }

    pub async fn update_issue(
        &self,
        issue_number: u64,
        input: &UpdateGitHubIssueInput,
    ) -> Result<GitHubIssue, GitHubApiError> {
        let path = format!("{}/issues/{issue_number}", self.repo_path()?);
        let body = to_body(input)?;
        let issue = self.request_json(Method::PATCH, &path, Some(&body)).await?;
        Ok(normalize_issue(issue))
    }

    pub async fn list_issue_comments(
        &self,
        issue_number: u64,
    ) -> Result<Vec<GitHubIssueComment>, GitHubApiError> {
        let path = format!("{}/issues/{issue_number}/comments", self.repo_path()?);
        let comments = self.request_json_paginated(&path, &[]).await?;
        Ok(comments.into_iter().map(normalize_issue_comment).collect())
    }

    pub async fn add_issue_comment(
        &self,
        issue_number: u64,
        body: &str,
    ) -> Result<(), GitHubApiError> {
        let path = format!("{}/issues/{issue_number}/comments", self.repo_path()?);
        let mut payload = Map::new();
        payload.insert("body".to_string(), Value::String(body.trim().to_string()));
        self.request_json(Method::POST, &path, Some(&Value::Object(payload)))
            .await?;
        Ok(())
    }

    /// `/repos/{owner}/{repo}`, each segment URI-encoded; fails before any request when
    /// either is blank.
    pub fn repo_path(&self) -> Result<String, GitHubApiError> {
        let owner = self.config.owner.trim();
        let repo = self.config.repo.trim();
        if owner.is_empty() || repo.is_empty() {
            return Err(GitHubApiError::RepositoryNotConfigured);
        }
        Ok(format!(
            "/repos/{}/{}",
            encode_uri_component(owner),
            encode_uri_component(repo)
        ))
    }

    /// `base_url` + `pathname`, with every non-empty query value set.
    pub fn build_url(&self, pathname: &str, query: &[(&str, &str)]) -> Result<Url, GitHubApiError> {
        let raw = format!("{}{pathname}", self.config.base_url.trim_end_matches('/'));
        let mut url =
            Url::parse(&raw).map_err(|error| GitHubApiError::InvalidUrl(error.to_string()))?;
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
        body: Option<&Value>,
    ) -> Result<Value, GitHubApiError> {
        let url = self.build_url(pathname, &[])?;
        Ok(self.request_json_page(method, url, body).await?.data)
    }

    /// Every page of a list endpoint (100 per page), following the `Link` header.
    pub async fn request_json_paginated(
        &self,
        pathname: &str,
        query: &[(&str, &str)],
    ) -> Result<Vec<Value>, GitHubApiError> {
        let mut with_page_size = query.to_vec();
        with_page_size.push(("per_page", "100"));
        let mut next = Some(self.build_url(pathname, &with_page_size)?);
        let mut results = Vec::new();
        while let Some(url) = next.take() {
            let page = self.request_json_page(Method::GET, url, None).await?;
            match page.data {
                Value::Array(items) => results.extend(items),
                _ => {
                    return Err(GitHubApiError::InvalidResponse(
                        "expected a JSON array for a list endpoint".to_string(),
                    ));
                }
            }
            next = page
                .next_url
                .map(|link| {
                    Url::parse(&link).map_err(|error| GitHubApiError::InvalidUrl(error.to_string()))
                })
                .transpose()?;
        }
        Ok(results)
    }

    /// One JSON request against an absolute URL, returning the next-page link too.
    pub async fn request_json_page(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
    ) -> Result<GitHubJsonPage, GitHubApiError> {
        let mut request = self
            .client
            .request(method, url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::USER_AGENT, GITHUB_USER_AGENT)
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .bearer_auth(&self.config.token);
        if let Some(body) = body {
            request = request.body(body.to_string());
        }
        let response = request.send().await.map_err(transport_error)?;
        let status = response.status();
        let next_url = parse_github_next_link(
            response
                .headers()
                .get(reqwest::header::LINK)
                .and_then(|value| value.to_str().ok()),
        );
        let text = response.text().await.map_err(transport_error)?;
        if !status.is_success() {
            return Err(GitHubApiError::Http {
                status: status.as_u16(),
                message: format_github_error(
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
                .map_err(|error| GitHubApiError::InvalidResponse(error.to_string()))?
        };
        Ok(GitHubJsonPage { data, next_url })
    }
}

fn to_body<T: Serialize>(input: &T) -> Result<Value, GitHubApiError> {
    serde_json::to_value(input).map_err(|error| GitHubApiError::InvalidResponse(error.to_string()))
}

fn transport_error(error: reqwest::Error) -> GitHubApiError {
    GitHubApiError::Transport(error.without_url().to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        CreateGitHubIssueInput, GitHubApiConfig, GitHubApiError, GitHubApiService,
        GitHubIssueState, UpdateGitHubIssueInput, encode_uri_component, format_github_error,
        parse_github_next_link,
    };
    use crate::test_support::{MockResponse, MockServer};

    fn config(base_url: &str) -> GitHubApiConfig {
        GitHubApiConfig {
            base_url: format!("{base_url}/"),
            owner: "octo cat".to_string(),
            repo: "demo".to_string(),
            token: "ghp-secret".to_string(),
        }
    }

    #[test]
    fn the_next_link_is_read_from_a_link_header() {
        let header = r#"<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last""#;
        assert_eq!(
            parse_github_next_link(Some(header)).as_deref(),
            Some("https://api.github.com/x?page=2")
        );
        assert_eq!(
            parse_github_next_link(Some(r#"<https://x/?page=1>; rel="prev""#)),
            None
        );
        assert_eq!(parse_github_next_link(None), None);
    }

    #[test]
    fn errors_extract_github_message_and_field_details() {
        let body = json!({
            "message": "Validation Failed",
            "errors": [
                { "resource": "Issue", "field": "title", "code": "missing_field" },
                { "message": "labels are invalid" }
            ]
        });
        assert_eq!(
            format_github_error(422, "Unprocessable Entity", &body.to_string()),
            "GitHub request failed (HTTP 422 Unprocessable Entity): Validation Failed; title: missing_field; labels are invalid"
        );
        assert_eq!(
            format_github_error(500, "", "  "),
            "GitHub request failed (HTTP 500)."
        );
        assert_eq!(
            format_github_error(502, "Bad Gateway", "<html>\n  bad\n</html>"),
            "GitHub request failed (HTTP 502 Bad Gateway): <html> bad </html>"
        );
        let long = "x".repeat(300);
        let message = format_github_error(500, "Internal Server Error", &long);
        assert!(message.ends_with('…'));
        assert_eq!(
            message.split(": ").nth(1).map(|d| d.chars().count()),
            Some(200)
        );
    }

    #[test]
    fn uri_components_are_encoded_like_javascript() {
        assert_eq!(encode_uri_component("octo cat/x"), "octo%20cat%2Fx");
        assert_eq!(encode_uri_component("a-b_c.d!~*'()"), "a-b_c.d!~*'()");
        assert_eq!(encode_uri_component("é"), "%C3%A9");
    }

    #[test]
    fn the_token_never_appears_in_debug_output() {
        let rendered = format!("{:?}", config("http://localhost"));
        assert!(!rendered.contains("ghp-secret"));
        assert!(rendered.contains("<redacted>"));
    }

    #[tokio::test]
    async fn a_blank_owner_fails_before_any_request() {
        let mut blank = config("http://127.0.0.1:9");
        blank.owner = "  ".to_string();
        let error = GitHubApiService::new(blank)
            .get_repo()
            .await
            .expect_err("a blank owner is refused");
        assert_eq!(error, GitHubApiError::RepositoryNotConfigured);
        assert_eq!(error.to_string(), "No GitHub repository is configured.");
    }

    #[tokio::test]
    async fn requests_carry_github_headers_and_paginate_through_link_headers() {
        let server = MockServer::start(|request| {
            if request.query_param("page").as_deref() == Some("2") {
                return MockResponse::json(&json!([
                    { "id": 3, "number": 3, "title": "Third", "state": "closed" }
                ]));
            }
            let next = format!(
                "<http://{}{}?page=2>; rel=\"next\"",
                request.header("host").unwrap_or_default(),
                request.path()
            );
            MockResponse::json(&json!([
                { "id": 1, "number": 1, "title": "First", "state": "open", "labels": ["status: Doing", { "name": "bug" }, { "name": " " }],
                  "user": { "login": "octocat" }, "assignees": [{ "login": "hubot", "name": "Hubot" }, null] },
                { "id": 2, "number": 2, "title": "A PR", "pull_request": {} }
            ]))
            .with_header("link", &next)
        })
        .await;

        let issues = GitHubApiService::new(config(&server.base_url))
            .list_issues()
            .await
            .expect("issues list");
        assert_eq!(
            issues.iter().map(|i| i.number).collect::<Vec<_>>(),
            vec![1, 3]
        );
        assert_eq!(issues[0].labels, vec!["status: Doing", "bug"]);
        assert_eq!(issues[0].author_login.as_deref(), Some("octocat"));
        assert_eq!(issues[0].assignees.len(), 1);
        assert_eq!(issues[1].state, "closed");

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        let first = &requests[0];
        assert_eq!(first.path(), "/repos/octo%20cat/demo/issues");
        assert_eq!(first.query_param("state").as_deref(), Some("all"));
        assert_eq!(first.query_param("sort").as_deref(), Some("updated"));
        assert_eq!(first.query_param("direction").as_deref(), Some("desc"));
        assert_eq!(first.query_param("per_page").as_deref(), Some("100"));
        assert_eq!(first.header("authorization"), Some("Bearer ghp-secret"));
        assert_eq!(first.header("accept"), Some("application/vnd.github+json"));
        assert_eq!(first.header("x-github-api-version"), Some("2022-11-28"));
        assert_eq!(first.header("user-agent"), Some("praxis"));
    }

    #[tokio::test]
    async fn create_and_update_send_only_the_fields_that_are_set() {
        let server = MockServer::start(|request| {
            MockResponse::json(&json!({ "id": 9, "number": 4, "title": "t", "state": "open", "method": request.method }))
        })
        .await;
        let client = GitHubApiService::new(config(&server.base_url));
        client
            .create_issue(&CreateGitHubIssueInput {
                title: "New".to_string(),
                ..CreateGitHubIssueInput::default()
            })
            .await
            .expect("issue created");
        client
            .update_issue(
                4,
                &UpdateGitHubIssueInput {
                    state: Some(GitHubIssueState::Closed),
                    labels: Some(vec!["bug".to_string()]),
                    ..UpdateGitHubIssueInput::default()
                },
            )
            .await
            .expect("issue updated");
        client
            .add_issue_comment(4, "  hello  ")
            .await
            .expect("comment added");

        let requests = server.requests();
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[0].json_body(), json!({ "title": "New" }));
        assert_eq!(requests[1].method, "PATCH");
        assert_eq!(requests[1].path(), "/repos/octo%20cat/demo/issues/4");
        assert_eq!(
            requests[1].json_body(),
            json!({ "state": "closed", "labels": ["bug"] })
        );
        assert_eq!(
            requests[2].path(),
            "/repos/octo%20cat/demo/issues/4/comments"
        );
        assert_eq!(requests[2].json_body(), json!({ "body": "hello" }));
    }

    #[tokio::test]
    async fn comments_prefer_the_author_name_and_an_empty_body_reads_as_an_empty_list() {
        let server = MockServer::start(|request| {
            if request.path().ends_with("/comments") {
                MockResponse::json(&json!([
                    { "id": 11, "body": "hi", "user": { "login": "octocat", "name": "Octo Cat" } },
                    { "id": 12, "user": { "login": "hubot" } }
                ]))
            } else {
                MockResponse::text(200, "")
            }
        })
        .await;
        let client = GitHubApiService::new(config(&server.base_url));
        let comments = client.list_issue_comments(1).await.expect("comments");
        assert_eq!(comments[0].id, "11");
        assert_eq!(comments[0].author.as_deref(), Some("Octo Cat"));
        assert_eq!(comments[1].author.as_deref(), Some("hubot"));
        assert_eq!(comments[1].body, "");
        assert_eq!(
            client
                .request_json(reqwest::Method::POST, "/anything", None)
                .await
                .expect("empty body"),
            json!([])
        );
    }

    #[tokio::test]
    async fn an_error_status_keeps_its_code_and_github_message() {
        let server = MockServer::start(|_| {
            MockResponse::status_json(401, &json!({ "message": "Bad credentials" }))
        })
        .await;
        let error = GitHubApiService::new(config(&server.base_url))
            .get_current_user()
            .await
            .expect_err("401 fails");
        assert_eq!(error.status(), Some(401));
        assert_eq!(
            error.to_string(),
            "GitHub request failed (HTTP 401 Unauthorized): Bad credentials"
        );
    }
}
