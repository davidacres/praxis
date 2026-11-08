//! The issue tracker service contract (`backends/issueTrackerService.ts` port) and the log
//! sink the backends write to (`host/logSink.ts`).
//!
//! Every backend mode resolves to one [`IssueTrackerService`]. Errors are the message the
//! TypeScript would have thrown, so an IPC caller can surface them unchanged.
//!
//! The TypeScript's optional `getSubTasks` / `createSubTasks` become default methods that
//! refuse, with [`IssueTrackerService::supports_sub_tasks`] standing in for the
//! "is the method present" check.

use async_trait::async_trait;
use praxis_contracts::{
    BackendMode, Board, BoardDetails, BoardFilters, ConnectionCheck, CreateBoardInput,
    CreateIssueInput, FilterMetadata, IssueAttachment, IssueDetails, IssueFilters, IssueSummary,
    PagedIssues, ParentItemQueryOptions, Project, SubTaskSummary, UpdateBoardInput,
    UpdateIssueInput, WorkflowTransition,
};
use serde::{Deserialize, Serialize};

/// A tracker call's result; the error is the user-facing message.
pub type TrackerResult<T> = Result<T, String>;

const SUB_TASKS_UNSUPPORTED: &str = "Sub-tasks are not supported by this backend.";

/// A log destination shared by the backend services.
pub trait LogSink: Send + Sync {
    fn append_line(&self, message: &str);
}

/// A sink that drops every line.
#[derive(Debug, Default, Clone, Copy)]
pub struct SilentLogSink;

impl LogSink for SilentLogSink {
    fn append_line(&self, _message: &str) {}
}

/// One sub-task to create under a parent issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubTaskInput {
    pub summary: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_type: Option<String>,
}

/// The operations every tracker backend exposes to the host.
#[async_trait]
pub trait IssueTrackerService: Send + Sync {
    fn mode(&self) -> BackendMode;

    fn get_default_page_size(&self) -> usize;

    async fn reset(&self) -> TrackerResult<()>;

    async fn check_connection(&self) -> TrackerResult<ConnectionCheck>;

    async fn get_projects(&self, force_refresh: bool) -> TrackerResult<Vec<Project>>;

    async fn get_issues(
        &self,
        filters: &IssueFilters,
        start_at: usize,
        page_size: usize,
    ) -> TrackerResult<PagedIssues>;

    async fn get_filter_metadata(&self, filters: &IssueFilters) -> TrackerResult<FilterMetadata>;

    async fn get_parent_items(
        &self,
        filters: &IssueFilters,
        search_text: Option<&str>,
        options: Option<&ParentItemQueryOptions>,
    ) -> TrackerResult<Vec<IssueSummary>>;

    async fn supports_boards(&self) -> TrackerResult<bool>;

    async fn get_boards(&self, filters: &BoardFilters) -> TrackerResult<Vec<Board>>;

    async fn get_board_details(&self, board: &Board) -> TrackerResult<BoardDetails>;

    async fn create_board(&self, input: &CreateBoardInput) -> TrackerResult<Board>;

    async fn update_board(&self, board_id: &str, input: &UpdateBoardInput) -> TrackerResult<Board>;

    async fn delete_board(&self, board_id: &str) -> TrackerResult<()>;

    async fn get_issue(&self, issue_key: &str) -> TrackerResult<IssueDetails>;

    async fn create_issue(&self, input: &CreateIssueInput) -> TrackerResult<IssueDetails>;

    async fn update_issue(
        &self,
        issue_key: &str,
        input: &UpdateIssueInput,
    ) -> TrackerResult<IssueDetails>;

    async fn delete_issue(&self, issue_key: &str) -> TrackerResult<()>;

    async fn add_comment(&self, issue_key: &str, body: &str) -> TrackerResult<()>;

    async fn attach_file(
        &self,
        issue_key: &str,
        file_path: &str,
        file_name: Option<&str>,
    ) -> TrackerResult<()>;

    async fn download_attachment(
        &self,
        issue_key: &str,
        attachment: &IssueAttachment,
        target_file_path: &str,
    ) -> TrackerResult<()>;

    async fn get_transitions(&self, issue_key: &str) -> TrackerResult<Vec<WorkflowTransition>>;

    async fn transition_issue(&self, issue_key: &str, transition_id: &str) -> TrackerResult<()>;

    async fn get_browse_url(&self, issue: &IssueSummary) -> TrackerResult<Option<String>>;

    /// Display name to assign when using "Assign to me"; `None` if not known for this backend.
    async fn get_self_assignee_label(&self) -> TrackerResult<Option<String>>;

    /// Whether [`Self::get_sub_tasks`] and [`Self::create_sub_tasks`] are implemented.
    fn supports_sub_tasks(&self) -> bool {
        false
    }

    /// Fetches sub-tasks for a parent issue. Only the Jira MCP backend supports it.
    async fn get_sub_tasks(&self, _parent_key: &str) -> TrackerResult<Vec<SubTaskSummary>> {
        Err(SUB_TASKS_UNSUPPORTED.to_string())
    }

    /// Creates sub-tasks linked to a parent issue. Only the Jira MCP backend supports it.
    async fn create_sub_tasks(
        &self,
        _parent_key: &str,
        _project_key: &str,
        _sub_tasks: &[SubTaskInput],
    ) -> TrackerResult<Vec<String>> {
        Err(SUB_TASKS_UNSUPPORTED.to_string())
    }

    fn dispose(&self) {}
}

#[cfg(test)]
mod tests {
    use super::SubTaskInput;

    #[test]
    fn sub_task_input_uses_the_typescript_shape() {
        let input = SubTaskInput {
            summary: "Write tests".to_string(),
            description: "Cover the refusals".to_string(),
            issue_type: Some("Sub-task".to_string()),
        };
        let json = serde_json::to_value(&input).expect("sub-task input serializes");
        assert_eq!(
            json,
            serde_json::json!({
                "summary": "Write tests",
                "description": "Cover the refusals",
                "issueType": "Sub-task"
            })
        );
    }
}
