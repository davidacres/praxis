//! Read-only CI evidence provider contract (`ci/ciEvidenceProvider.ts` port).
//!
//! Resolved independently of a project's issue tracker: a Jira-backed project can still read
//! CI evidence from a GitHub Actions repository, and a folder project can read GitLab CI.
//! Every provider is read-only; nothing dispatches, cancels, or re-runs a job.
//!
//! [`CiSourceRef`] has the exact JSON shape of `praxis-workflows`'
//! `WorkflowEvidenceSourceRef` (a CI run's head commit and a local check's captured commit
//! are the same concept). It is redeclared here because `praxis-workflows` will depend on
//! this crate's GitHub client, and the reverse dependency would be a cycle.
//!
//! The TypeScript's `AbortSignal` parameters are dropped: dropping the returned future
//! cancels the request.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The commit a CI run built, explicit when unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CiSourceRef {
    Commit { sha: String },
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CiRunConclusion {
    Success,
    Failure,
    Cancelled,
    TimedOut,
    ActionRequired,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiRunSummary {
    /// Provider-specific run id — a GitHub Actions run id, a GitLab pipeline id.
    pub run_id: String,
    /// 1-based; a re-run produces further attempts of the same `run_id`.
    pub attempt: u32,
    pub source: CiSourceRef,
    pub conclusion: CiRunConclusion,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
    pub created_at: String,
    pub workflow_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiJobSummary {
    pub job_id: String,
    pub name: String,
    pub conclusion: CiRunConclusion,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiJobLogResult {
    pub content: String,
    /// True when the provider reports the log is no longer retrievable (expired retention,
    /// deleted artifact) — never an error.
    pub expired: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CiSecurityReportType {
    Sarif,
    GitlabSast,
    GitlabDependencyScanning,
    Dependabot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CiProviderKind {
    GithubActions,
    GitlabCi,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiSecurityReportResult {
    pub provider: CiProviderKind,
    pub run_id: String,
    pub sha: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_report: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_type: Option<CiSecurityReportType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiRunPage {
    pub runs: Vec<CiRunSummary>,
    pub has_more: bool,
}

/// One page of failed/cancelled runs, the jobs of one specific run attempt (never "the
/// latest attempt" implicitly), and a job's log. `page` is 1-based throughout.
#[async_trait]
pub trait CiEvidenceProvider: Send + Sync {
    fn kind(&self) -> CiProviderKind;

    /// `page_size` defaults to 30.
    async fn list_failed_runs(
        &self,
        page: u32,
        page_size: Option<u32>,
    ) -> Result<CiRunPage, String>;

    async fn list_jobs(&self, run_id: &str, attempt: u32) -> Result<Vec<CiJobSummary>, String>;

    async fn get_job_log(&self, job_id: &str) -> Result<CiJobLogResult, String>;

    /// Whether [`Self::get_security_reports`] is implemented.
    fn supports_security_reports(&self) -> bool {
        false
    }

    async fn get_security_reports(&self, _sha: &str) -> Result<CiSecurityReportResult, String> {
        Err("This CI provider does not read security reports.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{CiRunConclusion, CiRunSummary, CiSourceRef};

    #[test]
    fn run_summaries_use_the_typescript_shape() {
        let run = CiRunSummary {
            run_id: "1".to_string(),
            attempt: 2,
            source: CiSourceRef::Commit {
                sha: "abc".to_string(),
            },
            conclusion: CiRunConclusion::TimedOut,
            html_url: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            workflow_name: "CI".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&run).expect("run serializes"),
            json!({
                "runId": "1",
                "attempt": 2,
                "source": { "kind": "commit", "sha": "abc" },
                "conclusion": "timed_out",
                "createdAt": "2026-01-01T00:00:00Z",
                "workflowName": "CI"
            })
        );
        assert_eq!(
            serde_json::to_value(CiSourceRef::Unknown).expect("source serializes"),
            json!({ "kind": "unknown" })
        );
    }
}
