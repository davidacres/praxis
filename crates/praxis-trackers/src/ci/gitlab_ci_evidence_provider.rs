//! GitLab CI read-only evidence provider (`ci/gitLabCiEvidenceProvider.ts` port).
//!
//! Its config — and so its token, which needs only `read_api` — is independent of whatever
//! token the project's issue tracker uses. `base_url` is the API root (`…/api/v4`). As with
//! the GitHub Actions provider, requests go through [`GitLabApiService::send`] so headers and
//! transport live in one place; status handling and messages stay this provider's own.
//!
//! GitLab models runs differently from GitHub Actions: a run is a pipeline, and a re-run
//! creates a *new* pipeline id rather than a further attempt — so `attempt` is always 1,
//! kept only so the shared [`CiEvidenceProvider`] contract is one shape for both.

use async_trait::async_trait;
use reqwest::{Method, StatusCode};
use serde_json::Value;

use crate::ci::evidence_provider::{
    CiEvidenceProvider, CiJobLogResult, CiJobSummary, CiProviderKind, CiRunConclusion, CiRunPage,
    CiRunSummary, CiSecurityReportResult, CiSecurityReportType, CiSourceRef,
};
use crate::gitlab::api_service::{
    GitLabApiConfig, GitLabApiError, GitLabApiService, next_page_header, transport_error,
};
use crate::rest_support::encode_uri_component;

/// Same shape as the issue client's config, but deliberately a separate value whose
/// `base_url` is the API root, e.g. `https://gitlab.com/api/v4`.
pub type GitLabCiConfig = GitLabApiConfig;

const DEFAULT_PAGE_SIZE: u32 = 30;
const EPOCH_ISO: &str = "1970-01-01T00:00:00.000Z";

/// GitLab statuses onto the shared vocabulary. `skipped` has no shared value, so it reads
/// as `unknown` (the TypeScript passed the out-of-vocabulary string through).
fn normalize_conclusion(value: Option<&Value>) -> CiRunConclusion {
    match value.and_then(Value::as_str) {
        Some("success") => CiRunConclusion::Success,
        Some("failed") => CiRunConclusion::Failure,
        Some("canceled") => CiRunConclusion::Cancelled,
        _ => CiRunConclusion::Unknown,
    }
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
    let source = match raw.get("sha").and_then(Value::as_str).map(str::trim) {
        Some(sha) if !sha.is_empty() => CiSourceRef::Commit {
            sha: sha.to_string(),
        },
        _ => CiSourceRef::Unknown,
    };
    Some(CiRunSummary {
        run_id,
        attempt: 1,
        source,
        conclusion: normalize_conclusion(raw.get("status")),
        html_url: string_field(raw, "web_url"),
        created_at: string_field(raw, "created_at").unwrap_or_else(|| EPOCH_ISO.to_string()),
        workflow_name: string_field(raw, "name")
            .or_else(|| string_field(raw, "ref"))
            .unwrap_or_else(|| "Pipeline".to_string()),
    })
}

fn normalize_job(raw: &Value) -> Option<CiJobSummary> {
    Some(CiJobSummary {
        job_id: id_string(raw.get("id"))?,
        name: string_field(raw, "name").unwrap_or_else(|| "Job".to_string()),
        conclusion: normalize_conclusion(raw.get("status")),
        html_url: string_field(raw, "web_url"),
    })
}

fn status_text(status: StatusCode) -> &'static str {
    status.canonical_reason().unwrap_or_default()
}

/// A failed pipeline GET: the status GitLab answered with (when it answered) and the message.
struct GetError {
    status: Option<StatusCode>,
    message: String,
}

impl From<String> for GetError {
    fn from(message: String) -> Self {
        Self {
            status: None,
            message,
        }
    }
}

impl From<GitLabApiError> for GetError {
    fn from(error: GitLabApiError) -> Self {
        Self::from(error.to_string())
    }
}

/// Reads failed pipelines, their jobs and job traces from one GitLab project.
#[derive(Debug, Clone)]
pub struct GitLabCiEvidenceProvider {
    api: GitLabApiService,
}

impl GitLabCiEvidenceProvider {
    #[must_use]
    pub fn new(config: GitLabCiConfig) -> Self {
        Self {
            api: GitLabApiService::new(config),
        }
    }

    #[must_use]
    pub fn with_client(config: GitLabCiConfig, client: reqwest::Client) -> Self {
        Self {
            api: GitLabApiService::with_client(config, client),
        }
    }

    fn project_path(&self) -> Result<String, String> {
        self.api
            .encode_project_ref(None)
            .map(|project| format!("/projects/{project}"))
            .map_err(|error| match error {
                GitLabApiError::ProjectNotConfigured => {
                    "No GitLab project is configured for CI evidence.".to_string()
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

    /// The JSON body and `x-next-page` of a pipeline-API GET.
    async fn get(
        &self,
        pathname: &str,
        query: &[(&str, &str)],
    ) -> Result<(Value, Option<String>), GetError> {
        let response = self.send(pathname, query).await?;
        let status = response.status();
        let next_page = next_page_header(response.headers());
        let text = response.text().await.map_err(transport_error)?;
        if status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND {
            return Err(GetError {
                status: Some(status),
                message: format!(
                    "No permission to read pipelines for this project (HTTP {}).",
                    status.as_u16()
                ),
            });
        }
        if !status.is_success() {
            return Err(GetError {
                status: Some(status),
                message: format!(
                    "GitLab CI request failed (HTTP {} {}).",
                    status.as_u16(),
                    status_text(status)
                ),
            });
        }
        if text.trim().is_empty() {
            return Ok((Value::Array(Vec::new()), next_page));
        }
        let data = serde_json::from_str(&text)
            .map_err(|error| format!("GitLab CI returned invalid JSON: {error}"))?;
        Ok((data, next_page))
    }

    fn unavailable(run_id: &str, sha: &str) -> CiSecurityReportResult {
        CiSecurityReportResult {
            provider: CiProviderKind::GitlabCi,
            run_id: run_id.to_string(),
            sha: sha.to_string(),
            available: false,
            raw_report: None,
            report_type: None,
        }
    }
}

fn items(data: &Value) -> &[Value] {
    data.as_array().map_or(&[], Vec::as_slice)
}

#[async_trait]
impl CiEvidenceProvider for GitLabCiEvidenceProvider {
    fn kind(&self) -> CiProviderKind {
        CiProviderKind::GitlabCi
    }

    async fn list_failed_runs(
        &self,
        page: u32,
        page_size: Option<u32>,
    ) -> Result<CiRunPage, String> {
        let page_size = page_size.unwrap_or(DEFAULT_PAGE_SIZE);
        let path = format!("{}/pipelines", self.project_path()?);
        let (data, next_page) = self
            .get(
                &path,
                &[
                    ("per_page", &page_size.to_string()),
                    ("page", &page.to_string()),
                    ("status", "failed"),
                ],
            )
            .await
            .map_err(|error| error.message)?;
        Ok(CiRunPage {
            runs: items(&data).iter().filter_map(normalize_run).collect(),
            has_more: next_page.is_some(),
        })
    }

    /// GitLab has no re-run-in-place attempt, so `attempt` is accepted for contract symmetry
    /// and otherwise ignored.
    async fn list_jobs(&self, run_id: &str, _attempt: u32) -> Result<Vec<CiJobSummary>, String> {
        let path = format!(
            "{}/pipelines/{}/jobs",
            self.project_path()?,
            encode_uri_component(run_id)
        );
        let (data, _) = self
            .get(&path, &[("per_page", "100")])
            .await
            .map_err(|error| error.message)?;
        Ok(items(&data).iter().filter_map(normalize_job).collect())
    }

    async fn get_job_log(&self, job_id: &str) -> Result<CiJobLogResult, String> {
        let path = format!(
            "{}/jobs/{}/trace",
            self.project_path()?,
            encode_uri_component(job_id)
        );
        let response = self.send(&path, &[]).await?;
        let status = response.status();
        // A trace GitLab has already expired off job-log retention reads 404.
        if status == StatusCode::NOT_FOUND {
            return Ok(CiJobLogResult {
                content: String::new(),
                expired: true,
            });
        }
        if status == StatusCode::FORBIDDEN {
            return Err(
                "No permission to read this job’s trace (HTTP 403). The token needs read_api."
                    .to_string(),
            );
        }
        if !status.is_success() {
            return Err(format!(
                "GitLab CI trace request failed (HTTP {} {}).",
                status.as_u16(),
                status_text(status)
            ));
        }
        let content = response.text().await.map_err(transport_error)?;
        Ok(CiJobLogResult {
            content,
            expired: false,
        })
    }

    fn supports_security_reports(&self) -> bool {
        true
    }

    /// The security report summary of the first pipeline for `sha`. Only a 403 is an error;
    /// anything else that goes wrong reads as "not available".
    async fn get_security_reports(&self, sha: &str) -> Result<CiSecurityReportResult, String> {
        let project = self.project_path()?;
        let pipelines = match self
            .get(&format!("{project}/pipelines"), &[("sha", sha)])
            .await
        {
            Ok((data, _)) => data,
            Err(GetError {
                status: Some(StatusCode::FORBIDDEN),
                ..
            }) => {
                return Err(
                    "No permission to read GitLab pipelines (HTTP 403). The token needs read_api."
                        .to_string(),
                );
            }
            Err(_) => return Ok(Self::unavailable("", sha)),
        };
        let Some(pipeline_id) = items(&pipelines)
            .first()
            .and_then(|pipeline| id_string(pipeline.get("id")))
        else {
            return Ok(Self::unavailable("", sha));
        };

        let path = format!(
            "{project}/pipelines/{}/security_report_summary",
            encode_uri_component(&pipeline_id)
        );
        let Ok(response) = self.send(&path, &[]).await else {
            return Ok(Self::unavailable(&pipeline_id, sha));
        };
        let status = response.status();
        if status == StatusCode::FORBIDDEN {
            return Err(
                "No permission to read GitLab security reports (HTTP 403). The token needs read_api."
                    .to_string(),
            );
        }
        if !status.is_success() {
            return Ok(Self::unavailable(&pipeline_id, sha));
        }
        let Ok(report) = response.json::<Value>().await else {
            return Ok(Self::unavailable(&pipeline_id, sha));
        };
        Ok(CiSecurityReportResult {
            provider: CiProviderKind::GitlabCi,
            run_id: pipeline_id,
            sha: sha.to_string(),
            available: true,
            raw_report: Some(report),
            report_type: Some(CiSecurityReportType::GitlabSast),
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{GitLabCiConfig, GitLabCiEvidenceProvider};
    use crate::ci::evidence_provider::{
        CiEvidenceProvider, CiJobLogResult, CiProviderKind, CiRunConclusion, CiSecurityReportType,
        CiSourceRef,
    };
    use crate::test_support::{MockResponse, MockServer};

    fn config(base_url: &str) -> GitLabCiConfig {
        GitLabCiConfig {
            base_url: format!("{base_url}/api/v4"),
            project_path: "acme/demo".to_string(),
            token: "glpat-test".to_string(),
        }
    }

    fn provider(server: &MockServer) -> GitLabCiEvidenceProvider {
        GitLabCiEvidenceProvider::new(config(&server.base_url))
    }

    #[tokio::test]
    async fn list_failed_runs_follows_x_next_page_and_reports_no_next_page_as_no_more() {
        let server = MockServer::start(|request| {
            if request.query_param("page").as_deref() == Some("1") {
                return MockResponse::json(&json!([
                    { "id": 100, "sha": "a".repeat(40), "status": "failed", "created_at": "2026-01-01T00:00:00Z", "ref": "main" }
                ]))
                .with_header("x-next-page", "2");
            }
            MockResponse::json(&json!([
                { "id": 101, "sha": "b".repeat(40), "status": "failed", "created_at": "2026-01-02T00:00:00Z", "ref": "main" }
            ]))
        })
        .await;
        let provider = provider(&server);
        let page1 = provider.list_failed_runs(1, None).await.expect("page 1");
        assert_eq!(page1.runs[0].run_id, "100");
        assert_eq!(page1.runs[0].workflow_name, "main");
        assert_eq!(page1.runs[0].attempt, 1);
        assert!(page1.has_more);

        let page2 = provider.list_failed_runs(2, None).await.expect("page 2");
        assert_eq!(page2.runs[0].run_id, "101");
        assert!(!page2.has_more);

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].path(), "/api/v4/projects/acme%2Fdemo/pipelines");
        assert_eq!(requests[0].query_param("status").as_deref(), Some("failed"));
        assert_eq!(requests[0].query_param("per_page").as_deref(), Some("30"));
        assert_eq!(requests[0].header("private-token"), Some("glpat-test"));
    }

    #[tokio::test]
    async fn a_pipeline_missing_a_sha_reports_an_explicit_unknown_source() {
        let server = MockServer::start(|_| {
            MockResponse::json(
                &json!([{ "id": 100, "status": "failed", "created_at": "2026-01-01T00:00:00Z" }]),
            )
        })
        .await;
        let page = provider(&server)
            .list_failed_runs(1, None)
            .await
            .expect("page");
        assert_eq!(page.runs[0].source, CiSourceRef::Unknown);
        assert_eq!(page.runs[0].workflow_name, "Pipeline");
    }

    #[tokio::test]
    async fn gitlab_statuses_map_onto_the_shared_conclusion_vocabulary() {
        let server = MockServer::start(|_| {
            MockResponse::json(&json!([
                { "id": 1, "sha": "a".repeat(40), "status": "failed", "created_at": "2026-01-01T00:00:00Z" },
                { "id": 2, "sha": "b".repeat(40), "status": "canceled", "created_at": "2026-01-01T00:00:00Z" },
                { "id": 3, "status": "skipped" },
                { "status": "failed" }
            ]))
        })
        .await;
        let page = provider(&server)
            .list_failed_runs(1, None)
            .await
            .expect("page");
        assert_eq!(page.runs.len(), 3);
        assert_eq!(page.runs[0].conclusion, CiRunConclusion::Failure);
        assert_eq!(page.runs[1].conclusion, CiRunConclusion::Cancelled);
        assert_eq!(page.runs[2].conclusion, CiRunConclusion::Unknown);
        assert_eq!(page.runs[2].created_at, "1970-01-01T00:00:00.000Z");
    }

    #[tokio::test]
    async fn list_failed_runs_surfaces_a_missing_permissions_403_rather_than_an_empty_list() {
        let server = MockServer::start(|_| {
            MockResponse::status_json(403, &json!({ "message": "403 Forbidden" }))
        })
        .await;
        let error = provider(&server)
            .list_failed_runs(1, None)
            .await
            .expect_err("403 fails");
        assert_eq!(
            error,
            "No permission to read pipelines for this project (HTTP 403)."
        );
    }

    #[tokio::test]
    async fn list_jobs_reads_the_pipeline_jobs() {
        let server = MockServer::start(|_| {
            MockResponse::json(&json!([{ "id": 10, "name": "test", "status": "failed", "web_url": "https://x" }, { "name": "no id" }]))
        })
        .await;
        let jobs = provider(&server).list_jobs("42", 3).await.expect("jobs");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].job_id, "10");
        assert_eq!(jobs[0].conclusion, CiRunConclusion::Failure);
        assert_eq!(jobs[0].html_url.as_deref(), Some("https://x"));
        assert_eq!(
            server.requests()[0].path(),
            "/api/v4/projects/acme%2Fdemo/pipelines/42/jobs"
        );
    }

    #[tokio::test]
    async fn get_job_log_reports_a_404_trace_as_an_explicit_expired_state() {
        let server = MockServer::start(|_| MockResponse::text(404, "")).await;
        assert_eq!(
            provider(&server).get_job_log("1").await,
            Ok(CiJobLogResult {
                content: String::new(),
                expired: true
            })
        );
    }

    #[tokio::test]
    async fn get_job_log_surfaces_a_missing_permissions_403_distinctly_from_an_expired_trace() {
        let server = MockServer::start(|_| MockResponse::text(403, "")).await;
        let error = provider(&server)
            .get_job_log("1")
            .await
            .expect_err("403 fails");
        assert!(error.starts_with("No permission to read this job’s trace (HTTP 403)."));
    }

    #[tokio::test]
    async fn get_job_log_returns_the_raw_trace_text_on_success() {
        let server = MockServer::start(|_| MockResponse::text(200, "$ npm test\nok\n")).await;
        assert_eq!(
            provider(&server).get_job_log("1").await,
            Ok(CiJobLogResult {
                content: "$ npm test\nok\n".to_string(),
                expired: false
            })
        );
        assert_eq!(
            server.requests()[0].path(),
            "/api/v4/projects/acme%2Fdemo/jobs/1/trace"
        );
    }

    #[tokio::test]
    async fn a_missing_project_path_throws_before_any_network_attempt() {
        let server = MockServer::start(|_| MockResponse::text(500, "")).await;
        let mut blank = config(&server.base_url);
        blank.project_path = String::new();
        let error = GitLabCiEvidenceProvider::new(blank)
            .list_failed_runs(1, None)
            .await
            .expect_err("no project");
        assert_eq!(error, "No GitLab project is configured for CI evidence.");
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn security_reports_read_the_first_pipeline_summary_for_the_commit() {
        let server = MockServer::start(|request| {
            let path = request.path();
            if path.ends_with("/security_report_summary") {
                if path.contains("/pipelines/8/") {
                    MockResponse::text(404, "")
                } else {
                    MockResponse::json(&json!({ "sast": { "vulnerabilities_count": 2 } }))
                }
            } else {
                match request.query_param("sha").as_deref() {
                    Some("none") => MockResponse::json(&json!([])),
                    Some("denied") => MockResponse::text(403, ""),
                    Some("broken") => MockResponse::text(500, ""),
                    Some("nosummary") => MockResponse::json(&json!([{ "id": 8 }])),
                    _ => MockResponse::json(&json!([{ "id": 7 }, { "id": 6 }])),
                }
            }
        })
        .await;
        let provider = provider(&server);
        assert!(provider.supports_security_reports());

        let report = provider.get_security_reports("abc").await.expect("report");
        assert!(report.available);
        assert_eq!(report.provider, CiProviderKind::GitlabCi);
        assert_eq!(report.run_id, "7");
        assert_eq!(report.report_type, Some(CiSecurityReportType::GitlabSast));
        assert_eq!(
            report.raw_report,
            Some(json!({ "sast": { "vulnerabilities_count": 2 } }))
        );

        let none = provider.get_security_reports("none").await.expect("none");
        assert!(!none.available);
        assert_eq!(none.run_id, "");
        let broken = provider
            .get_security_reports("broken")
            .await
            .expect("broken");
        assert!(!broken.available);
        let missing = provider
            .get_security_reports("nosummary")
            .await
            .expect("no summary");
        assert!(!missing.available);
        assert_eq!(missing.run_id, "8");
        assert_eq!(
            provider
                .get_security_reports("denied")
                .await
                .expect_err("403"),
            "No permission to read GitLab pipelines (HTTP 403). The token needs read_api."
        );
    }
}
