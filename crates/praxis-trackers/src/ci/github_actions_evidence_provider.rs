//! GitHub Actions read-only evidence provider (`ci/githubActionsEvidenceProvider.ts` port).
//!
//! Its config — and so its token, which needs only `actions:read` / `contents:read` — is
//! independent of whatever token the project's issue tracker uses. Unlike the TypeScript,
//! which keeps a standalone client, requests go through [`GitHubApiService::send`] so headers
//! and transport live in one place; status handling and messages stay this provider's own.

use async_trait::async_trait;
use reqwest::{Method, StatusCode};
use serde_json::Value;

use crate::ci::evidence_provider::{
    CiEvidenceProvider, CiJobLogResult, CiJobSummary, CiProviderKind, CiRunConclusion, CiRunPage,
    CiRunSummary, CiSecurityReportResult, CiSecurityReportType, CiSourceRef,
};
use crate::github::api_service::{GitHubApiConfig, GitHubApiError, GitHubApiService};
use crate::rest_support::encode_uri_component;

/// Same shape as the issue client's config, but deliberately a separate value.
pub type GitHubActionsConfig = GitHubApiConfig;

const DEFAULT_PAGE_SIZE: u32 = 30;
const EPOCH_ISO: &str = "1970-01-01T00:00:00.000Z";

fn normalize_conclusion(value: Option<&Value>) -> CiRunConclusion {
    match value.and_then(Value::as_str) {
        Some("success") => CiRunConclusion::Success,
        Some("failure") => CiRunConclusion::Failure,
        Some("cancelled") => CiRunConclusion::Cancelled,
        Some("timed_out") => CiRunConclusion::TimedOut,
        Some("action_required") => CiRunConclusion::ActionRequired,
        _ => CiRunConclusion::Unknown,
    }
}

/// Conclusions that represent a failure worth diagnosing — a run in progress has none yet.
fn is_failure(conclusion: CiRunConclusion) -> bool {
    matches!(
        conclusion,
        CiRunConclusion::Failure | CiRunConclusion::Cancelled | CiRunConclusion::TimedOut
    )
}

fn id_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

fn string_field(raw: &Value, key: &str) -> Option<String> {
    raw.get(key).and_then(Value::as_str).map(str::to_string)
}

fn normalize_run(raw: &Value) -> Option<CiRunSummary> {
    let run_id = id_string(raw.get("id"))?;
    let source = match raw.get("head_sha").and_then(Value::as_str).map(str::trim) {
        Some(sha) if !sha.is_empty() => CiSourceRef::Commit {
            sha: sha.to_string(),
        },
        _ => CiSourceRef::Unknown,
    };
    Some(CiRunSummary {
        run_id,
        attempt: raw
            .get("run_attempt")
            .and_then(Value::as_u64)
            .and_then(|attempt| u32::try_from(attempt).ok())
            .unwrap_or(1),
        source,
        conclusion: normalize_conclusion(raw.get("conclusion")),
        html_url: string_field(raw, "html_url"),
        created_at: string_field(raw, "created_at").unwrap_or_else(|| EPOCH_ISO.to_string()),
        workflow_name: string_field(raw, "name").unwrap_or_else(|| "Workflow".to_string()),
    })
}

fn normalize_job(raw: &Value) -> Option<CiJobSummary> {
    Some(CiJobSummary {
        job_id: id_string(raw.get("id"))?,
        name: string_field(raw, "name").unwrap_or_else(|| "Job".to_string()),
        conclusion: normalize_conclusion(raw.get("conclusion")),
        html_url: string_field(raw, "html_url"),
    })
}

fn status_text(status: StatusCode) -> &'static str {
    status.canonical_reason().unwrap_or_default()
}

/// Reads failed runs, their jobs and job logs from one repository's Actions.
#[derive(Debug, Clone)]
pub struct GitHubActionsEvidenceProvider {
    api: GitHubApiService,
}

impl GitHubActionsEvidenceProvider {
    #[must_use]
    pub fn new(config: GitHubActionsConfig) -> Self {
        Self {
            api: GitHubApiService::new(config),
        }
    }

    #[must_use]
    pub fn with_client(config: GitHubActionsConfig, client: reqwest::Client) -> Self {
        Self {
            api: GitHubApiService::with_client(config, client),
        }
    }

    fn repo_path(&self) -> Result<String, String> {
        self.api.repo_path().map_err(|error| match error {
            GitHubApiError::RepositoryNotConfigured => {
                "No GitHub repository is configured for CI evidence.".to_string()
            }
            other => other.to_string(),
        })
    }

    async fn send(
        &self,
        pathname: &str,
        query: &[(&str, &str)],
    ) -> Result<reqwest::Response, String> {
        let url = self.api.build_url(pathname, query)?;
        Ok(self.api.send(Method::GET, url, None).await?)
    }

    async fn get(&self, pathname: &str, query: &[(&str, &str)]) -> Result<Value, String> {
        let response = self.send(pathname, query).await?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| GitHubApiError::Transport(error.without_url().to_string()))?;
        if status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND {
            return Err(format!(
                "No permission to read Actions runs for this repository (HTTP {}).",
                status.as_u16()
            ));
        }
        if !status.is_success() {
            return Err(format!(
                "GitHub Actions request failed (HTTP {} {}).",
                status.as_u16(),
                status_text(status)
            ));
        }
        if text.trim().is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        serde_json::from_str(&text)
            .map_err(|error| format!("GitHub Actions returned invalid JSON: {error}"))
    }
}

#[async_trait]
impl CiEvidenceProvider for GitHubActionsEvidenceProvider {
    fn kind(&self) -> CiProviderKind {
        CiProviderKind::GithubActions
    }

    async fn list_failed_runs(
        &self,
        page: u32,
        page_size: Option<u32>,
    ) -> Result<CiRunPage, String> {
        let page_size = page_size.unwrap_or(DEFAULT_PAGE_SIZE);
        let path = format!("{}/actions/runs", self.repo_path()?);
        let parsed = self
            .get(
                &path,
                &[
                    ("per_page", &page_size.to_string()),
                    ("page", &page.to_string()),
                ],
            )
            .await?;
        let raw_runs: &[Value] = parsed
            .get("workflow_runs")
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice);
        let runs = raw_runs
            .iter()
            .filter_map(normalize_run)
            .filter(|run| is_failure(run.conclusion))
            .collect();
        let requested = u64::from(page) * u64::from(page_size);
        let has_more = match parsed.get("total_count").and_then(Value::as_u64) {
            Some(total) => requested < total,
            None => raw_runs.len() as u64 == u64::from(page_size),
        };
        Ok(CiRunPage { runs, has_more })
    }

    /// Jobs for one specific run attempt — never "whatever attempt is latest now".
    async fn list_jobs(&self, run_id: &str, attempt: u32) -> Result<Vec<CiJobSummary>, String> {
        let path = format!(
            "{}/actions/runs/{}/attempts/{attempt}/jobs",
            self.repo_path()?,
            encode_uri_component(run_id)
        );
        let parsed = self.get(&path, &[]).await?;
        Ok(parsed
            .get("jobs")
            .and_then(Value::as_array)
            .map(|jobs| jobs.iter().filter_map(normalize_job).collect())
            .unwrap_or_default())
    }

    async fn get_job_log(&self, job_id: &str) -> Result<CiJobLogResult, String> {
        let path = format!(
            "{}/actions/jobs/{}/logs",
            self.repo_path()?,
            encode_uri_component(job_id)
        );
        let response = self.send(&path, &[]).await?;
        let status = response.status();
        // A log past its retention window, or one GitHub has already reaped, reads as
        // 404/410 — an explicit expired state, not an error.
        if status == StatusCode::NOT_FOUND || status == StatusCode::GONE {
            return Ok(CiJobLogResult {
                content: String::new(),
                expired: true,
            });
        }
        if status == StatusCode::FORBIDDEN {
            return Err(
                "No permission to read this job’s log (HTTP 403). The token needs actions:read."
                    .to_string(),
            );
        }
        if !status.is_success() {
            return Err(format!(
                "GitHub Actions log request failed (HTTP {} {}).",
                status.as_u16(),
                status_text(status)
            ));
        }
        let content = response
            .text()
            .await
            .map_err(|error| GitHubApiError::Transport(error.without_url().to_string()))?;
        Ok(CiJobLogResult {
            content,
            expired: false,
        })
    }

    fn supports_security_reports(&self) -> bool {
        true
    }

    async fn get_security_reports(&self, sha: &str) -> Result<CiSecurityReportResult, String> {
        let path = format!("{}/code-scanning/alerts", self.repo_path()?);
        let response = self.send(&path, &[("ref", sha)]).await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(CiSecurityReportResult {
                provider: CiProviderKind::GithubActions,
                run_id: String::new(),
                sha: sha.to_string(),
                available: false,
                raw_report: None,
                report_type: None,
            });
        }
        if status == StatusCode::FORBIDDEN {
            return Err("No permission to read security alerts (HTTP 403). The token needs security_events:read.".to_string());
        }
        if !status.is_success() {
            return Err(format!(
                "GitHub code-scanning request failed (HTTP {} {}).",
                status.as_u16(),
                status_text(status)
            ));
        }
        let alerts: Value = response.json().await.map_err(|error| {
            format!(
                "GitHub code-scanning returned invalid JSON: {}",
                error.without_url()
            )
        })?;
        Ok(CiSecurityReportResult {
            provider: CiProviderKind::GithubActions,
            run_id: format!("gh-alerts-{}", sha.chars().take(7).collect::<String>()),
            sha: sha.to_string(),
            available: true,
            raw_report: Some(alerts),
            report_type: Some(CiSecurityReportType::Sarif),
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{GitHubActionsConfig, GitHubActionsEvidenceProvider};
    use crate::ci::evidence_provider::{
        CiEvidenceProvider, CiJobLogResult, CiRunConclusion, CiSecurityReportType, CiSourceRef,
    };
    use crate::test_support::{MockResponse, MockServer};

    fn config(base_url: &str) -> GitHubActionsConfig {
        GitHubActionsConfig {
            base_url: base_url.to_string(),
            owner: "acme".to_string(),
            repo: "demo".to_string(),
            token: "ghp-test".to_string(),
        }
    }

    fn provider(server: &MockServer) -> GitHubActionsEvidenceProvider {
        GitHubActionsEvidenceProvider::new(config(&server.base_url))
    }

    #[tokio::test]
    async fn list_failed_runs_paginates_using_total_count_and_filters_out_non_failures() {
        let server = MockServer::start(|request| {
            if request.query_param("page").as_deref() == Some("1") {
                return MockResponse::json(&json!({
                    "total_count": 3,
                    "workflow_runs": [
                        { "id": 1, "run_attempt": 1, "head_sha": "a".repeat(40), "conclusion": "failure", "created_at": "2026-01-01T00:00:00Z", "name": "CI" },
                        { "id": 2, "run_attempt": 1, "head_sha": "b".repeat(40), "conclusion": "success", "created_at": "2026-01-02T00:00:00Z", "name": "CI" }
                    ]
                }));
            }
            MockResponse::json(&json!({
                "total_count": 3,
                "workflow_runs": [
                    { "id": 3, "run_attempt": 2, "head_sha": "c".repeat(40), "conclusion": "cancelled", "created_at": "2026-01-03T00:00:00Z", "name": "CI" }
                ]
            }))
        })
        .await;
        let provider = provider(&server);

        let page1 = provider.list_failed_runs(1, Some(2)).await.expect("page 1");
        assert_eq!(page1.runs.len(), 1);
        assert_eq!(page1.runs[0].run_id, "1");
        assert!(page1.has_more);

        let page2 = provider.list_failed_runs(2, Some(2)).await.expect("page 2");
        assert_eq!(page2.runs.len(), 1);
        assert_eq!(page2.runs[0].run_id, "3");
        assert_eq!(page2.runs[0].attempt, 2);
        assert_eq!(page2.runs[0].conclusion, CiRunConclusion::Cancelled);
        assert!(!page2.has_more);

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].path(), "/repos/acme/demo/actions/runs");
        assert_eq!(requests[0].query_param("per_page").as_deref(), Some("2"));
        assert_eq!(requests[0].header("authorization"), Some("Bearer ghp-test"));
    }

    #[tokio::test]
    async fn without_total_count_a_full_page_means_more() {
        let server = MockServer::start(|_| {
            MockResponse::json(&json!({
                "workflow_runs": [{ "id": "7", "conclusion": "timed_out" }]
            }))
        })
        .await;
        let page = provider(&server)
            .list_failed_runs(1, Some(1))
            .await
            .expect("page");
        assert!(page.has_more);
        assert_eq!(page.runs[0].run_id, "7");
        assert_eq!(page.runs[0].attempt, 1);
        assert_eq!(page.runs[0].workflow_name, "Workflow");
        assert_eq!(page.runs[0].created_at, "1970-01-01T00:00:00.000Z");
    }

    #[tokio::test]
    async fn a_run_missing_head_sha_reports_an_explicit_unknown_source() {
        let server = MockServer::start(|_| {
            MockResponse::json(&json!({
                "total_count": 1,
                "workflow_runs": [{ "id": 1, "run_attempt": 1, "conclusion": "failure", "created_at": "2026-01-01T00:00:00Z", "name": "CI" }]
            }))
        })
        .await;
        let page = provider(&server)
            .list_failed_runs(1, None)
            .await
            .expect("page");
        assert_eq!(page.runs[0].source, CiSourceRef::Unknown);
        assert_eq!(
            server.requests()[0].query_param("per_page").as_deref(),
            Some("30")
        );
    }

    #[tokio::test]
    async fn list_jobs_is_scoped_to_the_requested_attempt() {
        let server = MockServer::start(|_| {
            MockResponse::json(&json!({
                "jobs": [{ "id": 10, "name": "build", "conclusion": "failure", "html_url": "https://x" }]
            }))
        })
        .await;
        let jobs = provider(&server).list_jobs("42", 2).await.expect("jobs");
        assert_eq!(
            server.requests()[0].path(),
            "/repos/acme/demo/actions/runs/42/attempts/2/jobs"
        );
        assert_eq!(jobs[0].job_id, "10");
        assert_eq!(jobs[0].html_url.as_deref(), Some("https://x"));
    }

    #[tokio::test]
    async fn list_failed_runs_surfaces_a_missing_permissions_403_rather_than_an_empty_list() {
        let server = MockServer::start(|_| {
            MockResponse::status_json(403, &json!({ "message": "Forbidden" }))
        })
        .await;
        let error = provider(&server)
            .list_failed_runs(1, None)
            .await
            .expect_err("403 fails");
        assert_eq!(
            error,
            "No permission to read Actions runs for this repository (HTTP 403)."
        );
    }

    #[tokio::test]
    async fn get_job_log_reports_404_and_410_as_an_explicit_expired_state() {
        for status in [404, 410] {
            let server = MockServer::start(move |_| MockResponse::text(status, "")).await;
            assert_eq!(
                provider(&server).get_job_log("1").await,
                Ok(CiJobLogResult {
                    content: String::new(),
                    expired: true
                })
            );
        }
    }

    #[tokio::test]
    async fn get_job_log_surfaces_a_missing_permissions_403_distinctly_from_an_expired_log() {
        let server = MockServer::start(|_| MockResponse::text(403, "")).await;
        let error = provider(&server)
            .get_job_log("1")
            .await
            .expect_err("403 fails");
        assert!(error.starts_with("No permission to read this job’s log (HTTP 403)."));
    }

    #[tokio::test]
    async fn get_job_log_returns_the_raw_log_text_on_success() {
        let server = MockServer::start(|_| MockResponse::text(200, "line one\nline two\n")).await;
        assert_eq!(
            provider(&server).get_job_log("1").await,
            Ok(CiJobLogResult {
                content: "line one\nline two\n".to_string(),
                expired: false
            })
        );
        assert_eq!(
            server.requests()[0].path(),
            "/repos/acme/demo/actions/jobs/1/logs"
        );
    }

    #[tokio::test]
    async fn a_missing_owner_or_repo_throws_before_any_network_attempt() {
        let server = MockServer::start(|_| MockResponse::text(500, "")).await;
        let mut blank = config(&server.base_url);
        blank.owner = String::new();
        let error = GitHubActionsEvidenceProvider::new(blank)
            .list_failed_runs(1, None)
            .await
            .expect_err("no repository");
        assert_eq!(error, "No GitHub repository is configured for CI evidence.");
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn security_reports_read_code_scanning_alerts_for_the_commit() {
        let server = MockServer::start(|request| {
            if request.query_param("ref").as_deref() == Some("missing") {
                MockResponse::text(404, "")
            } else {
                MockResponse::json(&json!([{ "number": 1 }]))
            }
        })
        .await;
        let provider = provider(&server);
        assert!(provider.supports_security_reports());
        let report = provider
            .get_security_reports("0123456789abcdef")
            .await
            .expect("report");
        assert!(report.available);
        assert_eq!(report.run_id, "gh-alerts-0123456");
        assert_eq!(report.report_type, Some(CiSecurityReportType::Sarif));
        assert_eq!(report.raw_report, Some(json!([{ "number": 1 }])));
        assert_eq!(
            server.requests()[0].path(),
            "/repos/acme/demo/code-scanning/alerts"
        );

        let missing = provider
            .get_security_reports("missing")
            .await
            .expect("not available");
        assert!(!missing.available);
        assert_eq!(missing.run_id, "");
    }
}
