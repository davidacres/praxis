//! Issue tracker backends (`FolderService`, `JiraCloudService`, `GitHubBoardService`,
//! `GitLabBoardService`, `DemoService`, `StubService`) and CI evidence providers.

pub mod ci;
pub mod folder_service;
pub mod github;
pub mod gitlab;
pub mod issue_tracker_service;
pub mod jira;
pub mod rest_support;
pub mod stub_backend_service;
#[cfg(test)]
mod test_support;

pub use folder_service::*;
pub use github::{GitHubBoardService, StaticGitHubConfig};
pub use gitlab::{GitLabBoardService, StaticGitLabConfig};
pub use issue_tracker_service::*;
pub use rest_support::{TrackerSecretSource, encode_uri_component};
pub use stub_backend_service::*;

/// Supported backend tracker modes in Praxis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackerBackendMode {
    Folder,
    Project,
    JiraCloud,
    GitHub,
    GitLab,
    Demo,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_modes_are_distinct() {
        assert_ne!(TrackerBackendMode::Folder, TrackerBackendMode::GitHub);
    }
}
