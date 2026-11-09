//! The config surface `GitLabBoardService` reads (`gitlab/gitLabConfigStore.ts` port).
//!
//! The host satisfies [`GitLabConfigStore`] with an adapter over a connection's settings
//! record; [`StaticGitLabConfig`] is a fixed in-memory one. Neither is serializable, so the
//! inline token cannot be persisted through them by accident.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

use crate::gitlab::api_service::{GitLabProjectRemote, infer_gitlab_project_from_repo};
use crate::rest_support::TrackerSecretSource;

/// Host-neutral GitLab connection settings.
pub trait GitLabConfigStore: Send + Sync {
    fn get_default_page_size(&self) -> usize;
    /// The instance root, e.g. `https://gitlab.com`.
    fn get_gitlab_url(&self) -> String;
    fn get_gitlab_project_path(&self) -> String;
    fn get_gitlab_list_all_accessible_boards(&self) -> bool;
    /// `group/project::<boardId>` references.
    fn get_gitlab_selected_board_refs(&self) -> Vec<String>;
    /// Inline (non-secret-store) API key; may be empty.
    fn get_gitlab_api_key(&self) -> String;
    /// Mirrors folder's and GitHub's `allowIssueCreation` gate — off by default.
    fn get_gitlab_allow_issue_creation(&self) -> bool;
}

/// Infers the GitLab project from a checked-out repository.
#[async_trait]
pub trait GitLabProjectInference: Send + Sync {
    async fn infer(&self, repo_path: &Path) -> Result<GitLabProjectRemote, String>;
}

/// Reads the repository's `origin` remote with `git`.
#[derive(Debug, Default, Clone, Copy)]
pub struct GitRemoteProjectInference;

#[async_trait]
impl GitLabProjectInference for GitRemoteProjectInference {
    async fn infer(&self, repo_path: &Path) -> Result<GitLabProjectRemote, String> {
        infer_gitlab_project_from_repo(repo_path).await
    }
}

/// Reads `GITLAB_TOKEN` from the process environment.
#[must_use]
pub fn gitlab_token_from_env() -> Option<String> {
    std::env::var("GITLAB_TOKEN").ok()
}

/// The workspace folder lookup a host provides.
pub type WorkspaceFolderLookup = Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>;

/// Optional host hooks for `GitLabBoardService`.
#[derive(Clone)]
pub struct GitLabBoardServiceOptions {
    /// Takes precedence over the inline `get_gitlab_api_key()` value when set.
    pub secrets: Option<Arc<dyn TrackerSecretSource>>,
    /// Workspace folder used to infer the GitLab project from the checked-out repository
    /// when no project path is configured. Hosts without a workspace concept leave this
    /// unset and require a configured path.
    pub workspace_folder_path: Option<WorkspaceFolderLookup>,
    /// How the project is inferred from that folder; [`GitRemoteProjectInference`] unless a
    /// test replaces it.
    pub project_inference: Arc<dyn GitLabProjectInference>,
    /// The last-resort token lookup; [`gitlab_token_from_env`] unless a test replaces it.
    pub environment_token: fn() -> Option<String>,
}

impl Default for GitLabBoardServiceOptions {
    fn default() -> Self {
        Self {
            secrets: None,
            workspace_folder_path: None,
            project_inference: Arc::new(GitRemoteProjectInference),
            environment_token: gitlab_token_from_env,
        }
    }
}

impl fmt::Debug for GitLabBoardServiceOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GitLabBoardServiceOptions")
            .field("secrets", &self.secrets.as_ref().map(|_| "<secret source>"))
            .field(
                "workspace_folder_path",
                &self.workspace_folder_path.as_ref().map(|_| "<lookup>"),
            )
            .finish_non_exhaustive()
    }
}

/// Fixed GitLab settings.
#[derive(Clone, PartialEq, Eq)]
pub struct StaticGitLabConfig {
    pub default_page_size: usize,
    pub url: String,
    pub project_path: String,
    pub list_all_accessible_boards: bool,
    pub selected_board_refs: Vec<String>,
    pub api_key: String,
    pub allow_issue_creation: bool,
}

impl Default for StaticGitLabConfig {
    fn default() -> Self {
        Self {
            default_page_size: 25,
            url: String::new(),
            project_path: String::new(),
            list_all_accessible_boards: false,
            selected_board_refs: Vec::new(),
            api_key: String::new(),
            allow_issue_creation: false,
        }
    }
}

impl fmt::Debug for StaticGitLabConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StaticGitLabConfig")
            .field("default_page_size", &self.default_page_size)
            .field("url", &self.url)
            .field("project_path", &self.project_path)
            .field(
                "list_all_accessible_boards",
                &self.list_all_accessible_boards,
            )
            .field("selected_board_refs", &self.selected_board_refs)
            .field("api_key", &"<redacted>")
            .field("allow_issue_creation", &self.allow_issue_creation)
            .finish()
    }
}

impl GitLabConfigStore for StaticGitLabConfig {
    fn get_default_page_size(&self) -> usize {
        self.default_page_size
    }
    fn get_gitlab_url(&self) -> String {
        self.url.clone()
    }
    fn get_gitlab_project_path(&self) -> String {
        self.project_path.clone()
    }
    fn get_gitlab_list_all_accessible_boards(&self) -> bool {
        self.list_all_accessible_boards
    }
    fn get_gitlab_selected_board_refs(&self) -> Vec<String> {
        self.selected_board_refs.clone()
    }
    fn get_gitlab_api_key(&self) -> String {
        self.api_key.clone()
    }
    fn get_gitlab_allow_issue_creation(&self) -> bool {
        self.allow_issue_creation
    }
}

#[cfg(test)]
mod tests {
    use super::StaticGitLabConfig;

    #[test]
    fn the_api_key_never_appears_in_debug_output() {
        let config = StaticGitLabConfig {
            api_key: "glpat-secret".to_string(),
            ..StaticGitLabConfig::default()
        };
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("glpat-secret"));
        assert!(rendered.contains("<redacted>"));
    }
}
