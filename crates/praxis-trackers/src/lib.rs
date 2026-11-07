//! Issue tracker backends (`FolderService`, `JiraCloudService`, `GitHubBoardService`,
//! `GitLabBoardService`, `DemoService`, `StubService`) and CI evidence providers.

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
