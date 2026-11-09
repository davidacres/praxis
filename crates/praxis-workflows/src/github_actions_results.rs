//! GitHub Actions run results (`deployments/githubActionsResults.ts` port): a run's jobs,
//! its provider URLs, and job logs fetched with bounded backoff.
//!
//! Workflow success is kept apart from deployment health: a workflow can succeed while the
//! deployed app is unhealthy, or the reverse, so [`WorkflowRunResults`] reports the jobs and
//! the run's conclusion and leaves health to the caller.
//!
//! The backoff's waits go through [`Delay`], so tests run them instantly and can assert the
//! schedule. Unlike the TypeScript, which recognises network failures by matching Node error
//! codes in the message, every transport failure counts as transient here.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use praxis_trackers::github::{GitHubApiError, GitHubApiService};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::github_actions_api::{GitHubActionsError, GitHubActionsFailureKind, send, string_field};

/// Waits between retries.
#[async_trait]
pub trait Delay: Send + Sync {
    async fn delay(&self, duration: Duration);
}

/// Real waits, on the tokio timer.
#[derive(Debug, Clone, Copy, Default)]
pub struct TokioDelay;

#[async_trait]
impl Delay for TokioDelay {
    async fn delay(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowJobStatus {
    Queued,
    InProgress,
    Completed,
}

/// One job in a workflow run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJobResult {
    pub id: u64,
    pub name: String,
    pub status: WorkflowJobStatus,
    /// `success`, `failure`, `cancelled`, `skipped`, …; `None` until the job completes.
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub html_url: String,
}

/// One job's log, or why it could not be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLogFetch {
    pub job_id: u64,
    pub content: String,
    /// GitHub no longer has the log (404 or 410).
    pub expired: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUrls {
    pub workflow_run_url: String,
    /// Job id to the job's page.
    pub job_urls: BTreeMap<u64, String>,
}

/// A run's workflow outcome, kept apart from deployment health.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunResults {
    pub run_id: u64,
    pub html_url: String,
    /// `queued`, `in_progress` or `completed`.
    pub run_status: String,
    pub run_conclusion: Option<String>,
    pub jobs: Vec<WorkflowJobResult>,
    /// The run concluded with anything but success.
    pub workflow_failed: bool,
    pub provider_urls: ProviderUrls,
}

/// Retry bounds for a log fetch: the wait doubles from `initial_delay` up to `max_delay`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackoffConfig {
    pub max_attempts: u32,
    pub initial_delay: Duration,
    pub max_delay: Duration,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(30),
        }
    }
}

impl BackoffConfig {
    fn delay_after(&self, attempt: u32) -> Duration {
        let factor = 2u32.saturating_pow(attempt.saturating_sub(1));
        self.initial_delay
            .saturating_mul(factor)
            .min(self.max_delay)
    }
}

/// Reads one repository's run results. The token needs `actions:read`.
#[derive(Clone)]
pub struct GitHubActionsResults {
    api: GitHubApiService,
    delay: Arc<dyn Delay>,
}

impl std::fmt::Debug for GitHubActionsResults {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitHubActionsResults")
            .field("api", &self.api)
            .finish_non_exhaustive()
    }
}

impl GitHubActionsResults {
    #[must_use]
    pub fn new(api: GitHubApiService) -> Self {
        Self::with_delay(api, Arc::new(TokioDelay))
    }

    /// Waits between retries through `delay` instead of the real timer.
    #[must_use]
    pub fn with_delay(api: GitHubApiService, delay: Arc<dyn Delay>) -> Self {
        Self { api, delay }
    }

    /// The jobs of one attempt of a run (attempts are 1-based).
    pub async fn get_run_jobs(
        &self,
        run_id: u64,
        attempt: u32,
    ) -> Result<Vec<WorkflowJobResult>, GitHubActionsError> {
        let path = format!(
            "{}/actions/runs/{run_id}/attempts/{attempt}/jobs",
            self.api.repo_path()?
        );
        let reply = send(&self.api, Method::GET, &path, &[], None).await?;
        if matches!(reply.status, 403 | 404) {
            return Err(GitHubActionsError::Refused {
                kind: if reply.status == 404 {
                    GitHubActionsFailureKind::RunNotFound
                } else {
                    GitHubActionsFailureKind::InsufficientPermission
                },
                status: reply.status,
                message: format!(
                    "GitHub Actions results request failed (HTTP {}).",
                    reply.status
                ),
            });
        }
        if !reply.ok() {
            return Err(GitHubActionsError::Failed(format!(
                "GitHub Actions results request failed ({}).",
                reply.status_line()
            )));
        }
        Ok(reply
            .json()?
            .get("jobs")
            .and_then(Value::as_array)
            .map(|jobs| jobs.iter().filter_map(normalize_job).collect())
            .unwrap_or_default())
    }

    /// A run's jobs and provider URLs, from run metadata the caller already has. Logs are
    /// fetched separately by [`Self::fetch_job_log`].
    pub async fn get_run_results(
        &self,
        run_id: u64,
        attempt: u32,
        run_status: &str,
        run_conclusion: Option<&str>,
        html_url: &str,
    ) -> Result<WorkflowRunResults, GitHubActionsError> {
        let jobs = self.get_run_jobs(run_id, attempt).await?;
        let job_urls = jobs
            .iter()
            .map(|job| (job.id, job.html_url.clone()))
            .collect();
        Ok(WorkflowRunResults {
            run_id,
            html_url: html_url.to_string(),
            run_status: run_status.to_string(),
            run_conclusion: run_conclusion.map(str::to_string),
            jobs,
            workflow_failed: run_conclusion.is_some_and(|conclusion| conclusion != "success"),
            provider_urls: ProviderUrls {
                workflow_run_url: html_url.to_string(),
                job_urls,
            },
        })
    }

    /// One job's log. A rate limit, a 5xx or a network failure is retried with backoff; an
    /// expired log (404, 410) or a permission error (403) is reported at once. Never fails:
    /// every problem comes back in [`JobLogFetch::error`].
    pub async fn fetch_job_log(&self, job_id: u64, backoff: BackoffConfig) -> JobLogFetch {
        let failed = |error: String| JobLogFetch {
            job_id,
            content: String::new(),
            expired: false,
            error: Some(error),
        };
        let path = match self.api.repo_path() {
            Ok(repo) => format!("{repo}/actions/jobs/{job_id}/logs"),
            Err(error) => return failed(format!("Unexpected error fetching logs: {error}")),
        };

        let max_attempts = backoff.max_attempts.max(1);
        let mut last_error = String::from("Unknown error");
        for attempt in 1..=max_attempts {
            match send(&self.api, Method::GET, &path, &[], None).await {
                Ok(reply) if reply.ok() => {
                    return JobLogFetch {
                        job_id,
                        content: reply.text,
                        expired: false,
                        error: None,
                    };
                }
                Ok(reply) if matches!(reply.status, 404 | 410) => {
                    return JobLogFetch {
                        job_id,
                        content: String::new(),
                        expired: true,
                        error: None,
                    };
                }
                Ok(reply) if reply.status == 403 => {
                    return failed(
                        "No permission to read logs (HTTP 403). Token needs actions:read."
                            .to_string(),
                    );
                }
                Ok(reply) if reply.status == 429 || (500..600).contains(&reply.status) => {
                    last_error = format!(
                        "GitHub API returned HTTP {} (transient, will retry)",
                        reply.status
                    );
                }
                Ok(reply) => {
                    return failed(format!("GitHub API returned {}", reply.status_line()));
                }
                Err(GitHubApiError::Transport(message)) => last_error = message,
                Err(error) => return failed(format!("Unexpected error fetching logs: {error}")),
            }
            if attempt < max_attempts {
                self.delay.delay(backoff.delay_after(attempt)).await;
            }
        }
        failed(format!(
            "Failed to fetch logs after {max_attempts} attempts: {last_error}"
        ))
    }
}

fn normalize_job(raw: &Value) -> Option<WorkflowJobResult> {
    let id = raw.get("id")?.as_u64()?;
    let status = match raw.get("status").and_then(Value::as_str) {
        Some("in_progress") => WorkflowJobStatus::InProgress,
        Some("completed") => WorkflowJobStatus::Completed,
        _ => WorkflowJobStatus::Queued,
    };
    Some(WorkflowJobResult {
        id,
        name: string_field(raw, "name").unwrap_or_else(|| format!("job-{id}")),
        status,
        conclusion: string_field(raw, "conclusion"),
        started_at: string_field(raw, "started_at"),
        completed_at: string_field(raw, "completed_at"),
        html_url: string_field(raw, "html_url").unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_http::{MockResponse, MockServer};
    use praxis_trackers::github::GitHubApiConfig;
    use serde_json::json;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Records each requested wait instead of sleeping.
    #[derive(Default)]
    struct RecordedDelays(Mutex<Vec<Duration>>);

    #[async_trait]
    impl Delay for RecordedDelays {
        async fn delay(&self, duration: Duration) {
            self.0.lock().expect("delays lock").push(duration);
        }
    }

    impl RecordedDelays {
        fn taken(&self) -> Vec<Duration> {
            self.0.lock().expect("delays lock").clone()
        }
    }

    fn api(base_url: &str) -> GitHubApiService {
        GitHubApiService::new(GitHubApiConfig {
            base_url: base_url.to_string(),
            owner: "acme".to_string(),
            repo: "demo".to_string(),
            token: "ghp-test".to_string(),
        })
    }

    fn results(base_url: &str) -> (GitHubActionsResults, Arc<RecordedDelays>) {
        let delays = Arc::new(RecordedDelays::default());
        let delay: Arc<dyn Delay> = delays.clone();
        (
            GitHubActionsResults::with_delay(api(base_url), delay),
            delays,
        )
    }

    fn quick_backoff(max_attempts: u32) -> BackoffConfig {
        BackoffConfig {
            max_attempts,
            initial_delay: Duration::from_millis(10),
            max_delay: Duration::from_millis(50),
        }
    }

    fn job(id: u64, name: &str, status: &str, conclusion: Option<&str>) -> Value {
        json!({
            "id": id,
            "name": name,
            "status": status,
            "conclusion": conclusion,
            "html_url": format!("https://github.com/acme/demo/runs/{id}")
        })
    }

    async fn serve_jobs(jobs: Vec<Value>) -> MockServer {
        let body = json!({ "jobs": jobs });
        MockServer::start(move |_| MockResponse::json(&body)).await
    }

    /// Answers each request with the next of `answers`, repeating the last.
    async fn serve_sequence(answers: Vec<MockResponse>) -> MockServer {
        let calls = AtomicUsize::new(0);
        MockServer::start(move |_| {
            let index = calls.fetch_add(1, Ordering::SeqCst).min(answers.len() - 1);
            answers[index].clone()
        })
        .await
    }

    // ── get_run_jobs ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_run_jobs_normalizes_a_runs_jobs() {
        let server = serve_jobs(vec![
            json!({
                "id": 1, "name": "Build", "status": "completed", "conclusion": "success",
                "started_at": "2026-09-09T00:00:00Z", "completed_at": "2026-09-09T00:05:00Z",
                "html_url": "https://github.com/acme/demo/runs/1"
            }),
            job(2, "Test", "completed", Some("failure")),
        ])
        .await;
        let (results, _) = results(&server.base_url);
        let jobs = results.get_run_jobs(101, 1).await.expect("jobs");
        assert_eq!(jobs.len(), 2);
        assert_eq!(
            serde_json::to_value(&jobs[0]).expect("serialize"),
            json!({
                "id": 1,
                "name": "Build",
                "status": "completed",
                "conclusion": "success",
                "startedAt": "2026-09-09T00:00:00Z",
                "completedAt": "2026-09-09T00:05:00Z",
                "htmlUrl": "https://github.com/acme/demo/runs/1"
            })
        );
        assert_eq!(jobs[1].conclusion.as_deref(), Some("failure"));
        assert_eq!(
            server.requests()[0].path(),
            "/repos/acme/demo/actions/runs/101/attempts/1/jobs"
        );
    }

    #[tokio::test]
    async fn a_cancelled_job_keeps_its_conclusion() {
        let server = serve_jobs(vec![job(1, "Deploy", "completed", Some("cancelled"))]).await;
        let (results, _) = results(&server.base_url);
        let jobs = results.get_run_jobs(101, 1).await.expect("jobs");
        assert_eq!(jobs[0].conclusion.as_deref(), Some("cancelled"));
    }

    #[tokio::test]
    async fn an_in_progress_job_has_no_conclusion() {
        let server = serve_jobs(vec![job(1, "Deploy", "in_progress", None)]).await;
        let (results, _) = results(&server.base_url);
        let jobs = results.get_run_jobs(101, 1).await.expect("jobs");
        assert_eq!(jobs[0].status, WorkflowJobStatus::InProgress);
        assert_eq!(jobs[0].conclusion, None);
    }

    #[tokio::test]
    async fn a_job_waiting_for_approval_or_a_runner_reads_as_queued() {
        let server = serve_jobs(vec![json!({
            "id": 1, "name": "Approve and Deploy", "status": "queued", "conclusion": null,
            "started_at": null, "completed_at": null, "html_url": "https://github.com/acme/demo/runs/1"
        })])
        .await;
        let (results, _) = results(&server.base_url);
        let jobs = results.get_run_jobs(101, 1).await.expect("jobs");
        assert_eq!(jobs[0].status, WorkflowJobStatus::Queued);
        assert_eq!(jobs[0].conclusion, None);
        assert_eq!(jobs[0].started_at, None);
    }

    #[tokio::test]
    async fn a_missing_run_is_run_not_found() {
        let server = MockServer::start(|_| MockResponse::text(404, "{}")).await;
        let (results, _) = results(&server.base_url);
        let error = results.get_run_jobs(101, 1).await.expect_err("missing");
        assert_eq!(error.kind(), Some(GitHubActionsFailureKind::RunNotFound));
    }

    // ── get_run_results ──────────────────────────────────────────────────

    #[tokio::test]
    async fn workflow_success_is_separate_from_job_outcomes() {
        let server = serve_jobs(vec![
            job(1, "Deploy", "completed", Some("success")),
            job(2, "HealthCheck", "completed", Some("failure")),
        ])
        .await;
        let (results, _) = results(&server.base_url);
        let outcome = results
            .get_run_results(
                101,
                1,
                "completed",
                Some("failure"),
                "https://github.com/acme/demo/runs/101",
            )
            .await
            .expect("results");
        assert_eq!(outcome.run_conclusion.as_deref(), Some("failure"));
        assert!(outcome.workflow_failed);
        // The deploy job succeeded even though the workflow failed.
        assert_eq!(outcome.jobs[0].conclusion.as_deref(), Some("success"));
        assert_eq!(outcome.jobs[1].conclusion.as_deref(), Some("failure"));
        assert!(outcome.provider_urls.workflow_run_url.contains("101"));
        assert!(outcome.provider_urls.job_urls.contains_key(&1));
        assert!(outcome.provider_urls.job_urls.contains_key(&2));
    }

    #[tokio::test]
    async fn a_successful_or_unfinished_run_has_not_failed() {
        let server = serve_jobs(vec![job(1, "Deploy", "completed", Some("success"))]).await;
        let (results, _) = results(&server.base_url);
        let succeeded = results
            .get_run_results(101, 1, "completed", Some("success"), "u")
            .await
            .expect("results");
        assert!(!succeeded.workflow_failed);
        let running = results
            .get_run_results(101, 1, "in_progress", None, "u")
            .await
            .expect("results");
        assert!(!running.workflow_failed);
    }

    #[tokio::test]
    async fn fetching_the_same_run_twice_reads_the_same_results() {
        let server = serve_jobs(vec![job(1, "Deploy", "completed", Some("success"))]).await;
        let (results, _) = results(&server.base_url);
        let first = results
            .get_run_results(101, 2, "completed", Some("success"), "u101")
            .await
            .expect("first");
        let second = results
            .get_run_results(101, 2, "completed", Some("success"), "u101")
            .await
            .expect("second");
        assert_eq!(server.requests().len(), 2);
        assert_eq!(first, second);
        assert_eq!(
            server.requests()[0].path(),
            "/repos/acme/demo/actions/runs/101/attempts/2/jobs"
        );
    }

    // ── fetch_job_log ────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_log_is_returned_on_success() {
        let server = MockServer::start(|_| {
            MockResponse::text(
                200,
                "2026-09-09T00:00:00Z [INFO] Deploying...\n2026-09-09T00:00:05Z [INFO] Done.",
            )
        })
        .await;
        let (results, _) = results(&server.base_url);
        let log = results.fetch_job_log(1, BackoffConfig::default()).await;
        assert_eq!(log.job_id, 1);
        assert!(log.content.contains("Deploying"));
        assert!(!log.expired);
        assert_eq!(log.error, None);
        assert_eq!(
            server.requests()[0].path(),
            "/repos/acme/demo/actions/jobs/1/logs"
        );
    }

    #[tokio::test]
    async fn a_404_or_410_log_is_expired_and_not_retried() {
        for status in [404, 410] {
            let server = MockServer::start(move |_| MockResponse::text(status, "{}")).await;
            let (results, delays) = results(&server.base_url);
            let log = results.fetch_job_log(1, BackoffConfig::default()).await;
            assert!(log.expired, "HTTP {status} is expired");
            assert_eq!(log.content, "");
            assert_eq!(log.error, None);
            assert_eq!(server.requests().len(), 1);
            assert!(delays.taken().is_empty());
        }
    }

    #[tokio::test]
    async fn a_403_log_is_a_permission_error() {
        let server = MockServer::start(|_| MockResponse::text(403, "{}")).await;
        let (results, _) = results(&server.base_url);
        let log = results.fetch_job_log(1, BackoffConfig::default()).await;
        assert!(!log.expired);
        assert!(
            log.error
                .as_deref()
                .is_some_and(|e| e.contains("permission"))
        );
        assert_eq!(log.content, "");
    }

    #[tokio::test]
    async fn a_rate_limited_log_is_retried_with_doubling_backoff() {
        let server = serve_sequence(vec![
            MockResponse::text(429, "{}"),
            MockResponse::text(429, "{}"),
            MockResponse::text(200, "Retry succeeded"),
        ])
        .await;
        let (results, delays) = results(&server.base_url);
        let log = results.fetch_job_log(1, quick_backoff(3)).await;
        assert_eq!(server.requests().len(), 3);
        assert!(log.content.contains("succeeded"));
        assert_eq!(log.error, None);
        assert_eq!(
            delays.taken(),
            [Duration::from_millis(10), Duration::from_millis(20)]
        );
    }

    #[tokio::test]
    async fn a_503_log_is_retried() {
        let server = serve_sequence(vec![
            MockResponse::text(503, "Service Unavailable"),
            MockResponse::text(200, "Log content"),
        ])
        .await;
        let (results, _) = results(&server.base_url);
        let log = results.fetch_job_log(1, quick_backoff(3)).await;
        assert_eq!(server.requests().len(), 2);
        assert_eq!(log.content, "Log content");
    }

    #[tokio::test]
    async fn the_backoff_is_capped_and_gives_up_after_max_attempts() {
        let server = MockServer::start(|_| MockResponse::text(500, "Server Error")).await;
        let (results, delays) = results(&server.base_url);
        let log = results.fetch_job_log(1, quick_backoff(5)).await;
        assert!(!log.expired);
        assert!(
            log.error
                .as_deref()
                .is_some_and(|e| e.contains("after 5 attempts"))
        );
        assert_eq!(server.requests().len(), 5);
        assert_eq!(delays.taken(), [10, 20, 40, 50].map(Duration::from_millis));
    }

    #[tokio::test]
    async fn a_network_failure_is_retried_then_reported() {
        // Nothing listens on port 9 (discard).
        let (results, delays) = results("http://127.0.0.1:9");
        let log = results.fetch_job_log(1, quick_backoff(2)).await;
        assert!(
            log.error
                .as_deref()
                .is_some_and(|e| e.starts_with("Failed to fetch logs after 2 attempts"))
        );
        assert_eq!(delays.taken().len(), 1);
    }

    #[tokio::test]
    async fn a_non_transient_failure_is_reported_without_retrying() {
        let (results, delays) = results("not a url");
        let log = results.fetch_job_log(1, quick_backoff(3)).await;
        assert!(
            log.error
                .as_deref()
                .is_some_and(|e| e.starts_with("Unexpected error fetching logs"))
        );
        assert!(delays.taken().is_empty());
    }

    #[tokio::test]
    async fn an_other_4xx_log_is_reported_without_retrying() {
        let server = MockServer::start(|_| MockResponse::text(400, "{}")).await;
        let (results, delays) = results(&server.base_url);
        let log = results.fetch_job_log(1, quick_backoff(3)).await;
        assert_eq!(
            log.error.as_deref(),
            Some("GitHub API returned HTTP 400 Bad Request")
        );
        assert!(delays.taken().is_empty());
    }
}
