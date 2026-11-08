//! The error and request helpers shared by the GitHub Actions deployment modules
//! (`githubActionsExecutor.ts`, `githubActionsObserver.ts`, `githubActionsResults.ts`).
//!
//! The TypeScript gives each module its own `fetch`-based client and error class. Here they
//! all go through `praxis_trackers`' [`GitHubApiService`], so headers, the configurable base
//! URL and token handling live in one place, and the three error classes become one type
//! whose [`GitHubActionsFailureKind`] covers each module's kinds. No message carries the
//! token: GitHub's own answers never echo it and transport errors are stripped of the URL.

use praxis_trackers::github::{GitHubApiError, GitHubApiService};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Why GitHub refused an Actions call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitHubActionsFailureKind {
    /// Dispatch: the workflow, ref or inputs were rejected (404 or 422).
    InvalidWorkflow,
    /// Observation: the workflow does not exist (404).
    WorkflowNotFound,
    /// Results: the run does not exist (404).
    RunNotFound,
    InsufficientPermission,
    RateLimited,
    Other,
}

/// A failed GitHub Actions call.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GitHubActionsError {
    /// GitHub answered and refused. A confirmed refusal: nothing happened on GitHub's side.
    #[error("{message}")]
    Refused {
        kind: GitHubActionsFailureKind,
        status: u16,
        message: String,
    },
    /// The request never got a readable answer, or no repository is configured. For a
    /// dispatch this is the "lost dispatch response": it may or may not have reached GitHub.
    #[error(transparent)]
    Request(#[from] GitHubApiError),
    /// Any other failure: an unexpected status or an unreadable body.
    #[error("{0}")]
    Failed(String),
}

impl GitHubActionsError {
    /// The refusal kind, when GitHub answered with one.
    #[must_use]
    pub fn kind(&self) -> Option<GitHubActionsFailureKind> {
        match self {
            Self::Refused { kind, .. } => Some(*kind),
            _ => None,
        }
    }

    /// The HTTP status GitHub refused with.
    #[must_use]
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Refused { status, .. } => Some(*status),
            _ => None,
        }
    }
}

/// One GitHub answer, read whatever its status.
pub(crate) struct ActionsReply {
    pub status: u16,
    pub status_text: &'static str,
    /// `X-RateLimit-Remaining: 0` — a 403 that is really a rate limit.
    pub rate_limit_exhausted: bool,
    pub text: String,
}

impl ActionsReply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// `HTTP <status> <reason>`, as the TypeScript's `${status} ${statusText}`.
    pub fn status_line(&self) -> String {
        if self.status_text.is_empty() {
            format!("HTTP {}", self.status)
        } else {
            format!("HTTP {} {}", self.status, self.status_text)
        }
    }

    /// The body as JSON; an empty body reads as `{}`.
    pub fn json(&self) -> Result<Value, GitHubActionsError> {
        if self.text.trim().is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        serde_json::from_str(&self.text).map_err(|error| {
            GitHubActionsError::Failed(format!("GitHub returned an unreadable response: {error}"))
        })
    }
}

/// Sends one request under the configured base URL and reads the answer.
pub(crate) async fn send(
    api: &GitHubApiService,
    method: Method,
    pathname: &str,
    query: &[(&str, &str)],
    body: Option<&Value>,
) -> Result<ActionsReply, GitHubApiError> {
    let url = api.build_url(pathname, query)?;
    let response = api.send(method, url, body).await?;
    let status = response.status();
    let rate_limit_exhausted = response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        == Some("0");
    let text = response
        .text()
        .await
        .map_err(|error| GitHubApiError::Transport(error.without_url().to_string()))?;
    Ok(ActionsReply {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default(),
        rate_limit_exhausted,
        text,
    })
}

/// A 403 is a rate limit when GitHub says no requests remain.
pub(crate) fn forbidden_kind(reply: &ActionsReply) -> GitHubActionsFailureKind {
    if reply.rate_limit_exhausted {
        GitHubActionsFailureKind::RateLimited
    } else {
        GitHubActionsFailureKind::InsufficientPermission
    }
}

/// A field when it is a JSON string.
pub(crate) fn string_field(raw: &Value, key: &str) -> Option<String> {
    raw.get(key).and_then(Value::as_str).map(str::to_string)
}
