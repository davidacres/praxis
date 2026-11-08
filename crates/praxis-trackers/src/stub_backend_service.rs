//! Placeholder backend for a connection mode this host cannot serve yet
//! (`backends/stubBackendService.ts` port).
//!
//! Reads return empty, so a configured-but-unported connection contributes no boards and no
//! error noise to aggregate listings; every mutation fails with a message naming the mode.
//! It never falls back to demo data, which made a broken or unported connection
//! indistinguishable from the demo data set.

use async_trait::async_trait;
use praxis_contracts::{
    BackendMode, Board, BoardDetails, BoardFilters, ConnectionCheck, ConnectionCheckStatus,
    CreateBoardInput, CreateIssueInput, FilterMetadata, IssueAttachment, IssueDetails,
    IssueFilters, IssueSummary, PagedIssues, ParentItemQueryOptions, Project, UpdateBoardInput,
    UpdateIssueInput, WorkflowTransition,
};

use crate::issue_tracker_service::{IssueTrackerService, TrackerResult};

/// The mode's wire name, as the TypeScript interpolates it.
#[must_use]
pub fn backend_mode_name(mode: BackendMode) -> &'static str {
    match mode {
        BackendMode::Jiracloud => "jiracloud",
        BackendMode::Demo => "demo",
        BackendMode::Github => "github",
        BackendMode::Gitlab => "gitlab",
        BackendMode::Folder => "folder",
        BackendMode::App => "app",
        BackendMode::Project => "project",
    }
}

/// The message a stub backend reports for `mode`.
#[must_use]
pub fn build_stub_backend_message(mode: BackendMode) -> String {
    match mode {
        BackendMode::Demo => {
            "Demo mode is disabled. Start Praxis with --demo to load sample data.".to_string()
        }
        BackendMode::Github => "GitHub project mode is not implemented yet. Current GitHub support is limited to setup metadata.".to_string(),
        BackendMode::Gitlab => "GitLab project mode is not implemented yet. Current GitLab support is limited to setup metadata and repository automation helpers.".to_string(),
        BackendMode::Jiracloud => "Jira is not configured. Add your Jira site URL and sign in with OAuth or an API token from the connection settings.".to_string(),
        other => format!("{} backend mode is not supported in this build.", backend_mode_name(other)),
    }
}

/// A backend that reads empty and refuses every mutation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StubBackendService {
    unsupported_mode: BackendMode,
}

impl StubBackendService {
    #[must_use]
    pub fn new(unsupported_mode: BackendMode) -> Self {
        Self { unsupported_mode }
    }

    fn refuse<T>(&self) -> TrackerResult<T> {
        Err(build_stub_backend_message(self.unsupported_mode))
    }
}

#[async_trait]
impl IssueTrackerService for StubBackendService {
    fn mode(&self) -> BackendMode {
        self.unsupported_mode
    }

    fn get_default_page_size(&self) -> usize {
        25
    }

    async fn reset(&self) -> TrackerResult<()> {
        Ok(())
    }

    async fn check_connection(&self) -> TrackerResult<ConnectionCheck> {
        Ok(ConnectionCheck {
            status: ConnectionCheckStatus::Error,
            message: build_stub_backend_message(self.unsupported_mode),
            tool_count: 0,
            project_count: None,
            server_name: None,
        })
    }

    async fn get_projects(&self, _force_refresh: bool) -> TrackerResult<Vec<Project>> {
        Ok(Vec::new())
    }

    async fn get_issues(
        &self,
        _filters: &IssueFilters,
        _start_at: usize,
        _page_size: usize,
    ) -> TrackerResult<PagedIssues> {
        Ok(PagedIssues {
            issues: Vec::new(),
            total: None,
            has_more: false,
        })
    }

    async fn get_filter_metadata(&self, _filters: &IssueFilters) -> TrackerResult<FilterMetadata> {
        Ok(FilterMetadata::default())
    }

    async fn get_parent_items(
        &self,
        _filters: &IssueFilters,
        _search_text: Option<&str>,
        _options: Option<&ParentItemQueryOptions>,
    ) -> TrackerResult<Vec<IssueSummary>> {
        Ok(Vec::new())
    }

    async fn supports_boards(&self) -> TrackerResult<bool> {
        Ok(false)
    }

    async fn get_boards(&self, _filters: &BoardFilters) -> TrackerResult<Vec<Board>> {
        Ok(Vec::new())
    }

    async fn get_board_details(&self, _board: &Board) -> TrackerResult<BoardDetails> {
        self.refuse()
    }

    async fn create_board(&self, _input: &CreateBoardInput) -> TrackerResult<Board> {
        self.refuse()
    }

    async fn update_board(
        &self,
        _board_id: &str,
        _input: &UpdateBoardInput,
    ) -> TrackerResult<Board> {
        self.refuse()
    }

    async fn delete_board(&self, _board_id: &str) -> TrackerResult<()> {
        self.refuse()
    }

    async fn get_issue(&self, issue_key: &str) -> TrackerResult<IssueDetails> {
        Err(format!(
            "Cannot load {issue_key}. {}",
            build_stub_backend_message(self.unsupported_mode)
        ))
    }

    async fn create_issue(&self, _input: &CreateIssueInput) -> TrackerResult<IssueDetails> {
        self.refuse()
    }

    async fn update_issue(
        &self,
        _issue_key: &str,
        _input: &UpdateIssueInput,
    ) -> TrackerResult<IssueDetails> {
        self.refuse()
    }

    async fn delete_issue(&self, _issue_key: &str) -> TrackerResult<()> {
        self.refuse()
    }

    async fn add_comment(&self, _issue_key: &str, _body: &str) -> TrackerResult<()> {
        self.refuse()
    }

    async fn attach_file(
        &self,
        _issue_key: &str,
        _file_path: &str,
        _file_name: Option<&str>,
    ) -> TrackerResult<()> {
        self.refuse()
    }

    async fn download_attachment(
        &self,
        _issue_key: &str,
        _attachment: &IssueAttachment,
        _target_file_path: &str,
    ) -> TrackerResult<()> {
        self.refuse()
    }

    async fn get_transitions(&self, _issue_key: &str) -> TrackerResult<Vec<WorkflowTransition>> {
        Ok(Vec::new())
    }

    async fn transition_issue(&self, _issue_key: &str, _transition_id: &str) -> TrackerResult<()> {
        self.refuse()
    }

    async fn get_browse_url(&self, _issue: &IssueSummary) -> TrackerResult<Option<String>> {
        Ok(None)
    }

    async fn get_self_assignee_label(&self) -> TrackerResult<Option<String>> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use praxis_contracts::{
        BackendMode, BoardFilters, ConnectionCheckStatus, CreateIssueInput, IssueFilters,
    };

    use super::{StubBackendService, build_stub_backend_message};
    use crate::issue_tracker_service::IssueTrackerService;

    #[test]
    fn each_mode_has_a_named_message() {
        assert!(build_stub_backend_message(BackendMode::Demo).contains("--demo"));
        assert!(build_stub_backend_message(BackendMode::Github).starts_with("GitHub project mode"));
        assert!(build_stub_backend_message(BackendMode::Gitlab).starts_with("GitLab project mode"));
        assert!(
            build_stub_backend_message(BackendMode::Jiracloud)
                .starts_with("Jira is not configured.")
        );
        assert_eq!(
            build_stub_backend_message(BackendMode::Folder),
            "folder backend mode is not supported in this build."
        );
        assert_eq!(
            build_stub_backend_message(BackendMode::App),
            "app backend mode is not supported in this build."
        );
    }

    #[tokio::test]
    async fn reads_are_empty_and_never_demo_data() {
        let stub = StubBackendService::new(BackendMode::Demo);
        assert_eq!(stub.mode(), BackendMode::Demo);
        assert_eq!(stub.get_default_page_size(), 25);
        assert!(stub.get_projects(false).await.expect("projects").is_empty());
        let page = stub
            .get_issues(&IssueFilters::default(), 0, 25)
            .await
            .expect("issues");
        assert!(page.issues.is_empty());
        assert!(!page.has_more);
        assert_eq!(
            serde_json::to_value(&page).expect("page serializes"),
            serde_json::json!({ "issues": [], "hasMore": false })
        );
        assert!(
            stub.get_boards(&BoardFilters::default())
                .await
                .expect("boards")
                .is_empty()
        );
        assert!(!stub.supports_boards().await.expect("supports boards"));
        assert!(
            stub.get_transitions("X-1")
                .await
                .expect("transitions")
                .is_empty()
        );
        assert_eq!(stub.get_self_assignee_label().await.expect("label"), None);
    }

    #[tokio::test]
    async fn the_connection_check_reports_the_mode_as_an_error() {
        let check = StubBackendService::new(BackendMode::Gitlab)
            .check_connection()
            .await
            .expect("check");
        assert_eq!(check.status, ConnectionCheckStatus::Error);
        assert_eq!(check.tool_count, 0);
        assert_eq!(
            check.message,
            build_stub_backend_message(BackendMode::Gitlab)
        );
    }

    #[tokio::test]
    async fn mutations_fail_with_the_named_message() {
        let stub = StubBackendService::new(BackendMode::Jiracloud);
        let message = build_stub_backend_message(BackendMode::Jiracloud);
        assert_eq!(
            stub.create_issue(&CreateIssueInput::default()).await,
            Err(message.clone())
        );
        assert_eq!(stub.delete_issue("X-1").await, Err(message.clone()));
        assert_eq!(
            stub.transition_issue("X-1", "t").await,
            Err(message.clone())
        );
        assert_eq!(
            stub.get_issue("X-1").await,
            Err(format!("Cannot load X-1. {message}"))
        );
    }
}
