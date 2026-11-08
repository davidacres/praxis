//! The config surface `GitHubBoardService` reads (`github/githubConfigStore.ts` port).
//!
//! The host satisfies [`GitHubConfigStore`] with an adapter over a connection's settings
//! record; [`StaticGitHubConfig`] is a fixed in-memory one. Neither is serializable, so the
//! inline token cannot be persisted through them by accident.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;

use crate::issue_tracker_service::TrackerResult;

/// Host-neutral GitHub connection settings.
pub trait GitHubConfigStore: Send + Sync {
    fn get_default_page_size(&self) -> usize;
    /// API base URL — blank means `https://api.github.com`; set it for GitHub Enterprise Server.
    fn get_github_api_url(&self) -> String;
    fn get_github_owner(&self) -> String;
    fn get_github_repo(&self) -> String;
    /// Inline (non-secret-store) token; may be empty.
    fn get_github_api_key(&self) -> String;
    /// Mirrors folder's `allowIssueCreation` gate — off by default.
    fn get_github_allow_issue_creation(&self) -> bool;
}

/// Resolves the personal access token from the host's secret store.
#[async_trait]
pub trait GitHubSecretSource: Send + Sync {
    async fn get_api_key(&self) -> TrackerResult<String>;
}

/// Reads `GITHUB_TOKEN` from the process environment.
#[must_use]
pub fn github_token_from_env() -> Option<String> {
    std::env::var("GITHUB_TOKEN").ok()
}

/// Optional host hooks for `GitHubBoardService`.
#[derive(Clone)]
pub struct GitHubBoardServiceOptions {
    /// Takes precedence over the inline `get_github_api_key()` value when set.
    pub secrets: Option<Arc<dyn GitHubSecretSource>>,
    /// The last-resort token lookup; [`github_token_from_env`] unless a test replaces it.
    pub environment_token: fn() -> Option<String>,
}

impl Default for GitHubBoardServiceOptions {
    fn default() -> Self {
        Self {
            secrets: None,
            environment_token: github_token_from_env,
        }
    }
}

impl fmt::Debug for GitHubBoardServiceOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GitHubBoardServiceOptions")
            .field("secrets", &self.secrets.as_ref().map(|_| "<secret source>"))
            .finish_non_exhaustive()
    }
}

/// Fixed GitHub settings.
#[derive(Clone, PartialEq, Eq)]
pub struct StaticGitHubConfig {
    pub default_page_size: usize,
    pub api_url: String,
    pub owner: String,
    pub repo: String,
    pub api_key: String,
    pub allow_issue_creation: bool,
}

impl Default for StaticGitHubConfig {
    fn default() -> Self {
        Self {
            default_page_size: 25,
            api_url: String::new(),
            owner: String::new(),
            repo: String::new(),
            api_key: String::new(),
            allow_issue_creation: false,
        }
    }
}

impl fmt::Debug for StaticGitHubConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StaticGitHubConfig")
            .field("default_page_size", &self.default_page_size)
            .field("api_url", &self.api_url)
            .field("owner", &self.owner)
            .field("repo", &self.repo)
            .field("api_key", &"<redacted>")
            .field("allow_issue_creation", &self.allow_issue_creation)
            .finish()
    }
}

impl GitHubConfigStore for StaticGitHubConfig {
    fn get_default_page_size(&self) -> usize {
        self.default_page_size
    }
    fn get_github_api_url(&self) -> String {
        self.api_url.clone()
    }
    fn get_github_owner(&self) -> String {
        self.owner.clone()
    }
    fn get_github_repo(&self) -> String {
        self.repo.clone()
    }
    fn get_github_api_key(&self) -> String {
        self.api_key.clone()
    }
    fn get_github_allow_issue_creation(&self) -> bool {
        self.allow_issue_creation
    }
}
