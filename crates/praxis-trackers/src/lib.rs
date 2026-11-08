//! Issue tracker backends (`FolderService`, `JiraCloudService`, `GitHubBoardService`,
//! `GitLabBoardService`, `DemoService`, `StubService`) and CI evidence providers.

pub mod folder_service;
pub mod github;
pub mod issue_tracker_service;
pub mod stub_backend_service;
#[cfg(test)]
mod test_support;

pub use folder_service::*;
pub use issue_tracker_service::*;
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
