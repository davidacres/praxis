//! GitHub Actions run observation and correlation (`deployments/githubActionsObserver.ts`
//! port): find the already-triggered workflow run a deployment belongs to.
//!
//! A run is matched on its workflow and its head commit: exactly one match attaches, several
//! are returned for explicit selection, and a run from any other commit is never attached.
//! Only `actions:read` is needed.
//!
//! Unlike the TypeScript, correlation asks GitHub for the artifact's commit (`head_sha`)
//! instead of paging through every run of the workflow, which for a busy workflow with no
//! match would read its entire history. The client-side SHA check stays as the stale-run
//! guard, so the TypeScript's never-produced `stale-run` outcome is not carried over.

use praxis_trackers::github::{GitHubApiService, encode_uri_component};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::deployment_profile::WorkflowEvidenceSourceRef;
use crate::github_actions_api::{
    GitHubActionsError, GitHubActionsFailureKind, forbidden_kind, send, string_field,
};

/// Correlation stops paging once it has this many candidates.
const MAX_CANDIDATES: usize = 10;
const CORRELATION_PAGE_SIZE: u32 = 10;

/// A workflow run that may belong to a deployment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunCandidate {
    pub id: u64,
    /// 1-based.
    pub attempt: u32,
    /// The commit the run was triggered for.
    pub sha: String,
    pub workflow_name: String,
    /// `queued`, `in_progress` or `completed`.
    pub status: String,
    /// `None` until the run completes.
    pub conclusion: Option<String>,
    pub created_at: String,
    pub html_url: String,
}

/// One page of a workflow's runs, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunsPage {
    pub runs: Vec<WorkflowRunCandidate>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WorkflowRunCorrelationOutcome {
    SingleCandidate { run: WorkflowRunCandidate },
    MultipleCandidates { runs: Vec<WorkflowRunCandidate> },
    NoCandidates,
}

/// Lists and correlates one repository's workflow runs.
#[derive(Debug, Clone)]
pub struct GitHubActionsObserver {
    api: GitHubApiService,
}

impl GitHubActionsObserver {
    #[must_use]
    pub fn new(api: GitHubApiService) -> Self {
        Self { api }
    }

    /// One page of a workflow's runs, newest first; `None` when the workflow does not exist.
    pub async fn list_workflow_runs(
        &self,
        workflow_id: &str,
        page: u32,
        page_size: u32,
    ) -> Result<Option<WorkflowRunsPage>, GitHubActionsError> {
        self.list_runs(workflow_id, page, page_size, None).await
    }

    /// Correlates a deployment with the run for its artifact's commit. A source with no
    /// known commit has nothing to match, so it has no candidates; nothing is requested.
    pub async fn correlate_workflow_run(
        &self,
        workflow_id: &str,
        source_commit: &WorkflowEvidenceSourceRef,
    ) -> Result<WorkflowRunCorrelationOutcome, GitHubActionsError> {
        let WorkflowEvidenceSourceRef::Commit { sha: expected_sha } = source_commit else {
            return Ok(WorkflowRunCorrelationOutcome::NoCandidates);
        };

        let mut candidates = Vec::new();
        let mut page = 1;
        loop {
            let Some(result) = self
                .list_runs(workflow_id, page, CORRELATION_PAGE_SIZE, Some(expected_sha))
                .await?
            else {
                return Ok(WorkflowRunCorrelationOutcome::NoCandidates);
            };
            // Stale-run protection: a run from any other commit is never a candidate.
            candidates.extend(
                result
                    .runs
                    .into_iter()
                    .filter(|run| &run.sha == expected_sha),
            );
            if !result.has_more || candidates.len() >= MAX_CANDIDATES {
                break;
            }
            page += 1;
        }

        Ok(match candidates.len() {
            0 => WorkflowRunCorrelationOutcome::NoCandidates,
            1 => WorkflowRunCorrelationOutcome::SingleCandidate {
                run: candidates.remove(0),
            },
            _ => WorkflowRunCorrelationOutcome::MultipleCandidates { runs: candidates },
        })
    }

    async fn list_runs(
        &self,
        workflow_id: &str,
        page: u32,
        page_size: u32,
        head_sha: Option<&str>,
    ) -> Result<Option<WorkflowRunsPage>, GitHubActionsError> {
        let path = format!(
            "{}/actions/workflows/{}/runs",
            self.api.repo_path()?,
            encode_uri_component(workflow_id)
        );
        let (per_page, page_text) = (page_size.to_string(), page.to_string());
        let mut query = vec![
            ("per_page", per_page.as_str()),
            ("page", page_text.as_str()),
        ];
        if let Some(sha) = head_sha {
            query.push(("head_sha", sha));
        }
        let reply = send(&self.api, Method::GET, &path, &query, None).await?;
        let kind = match reply.status {
            404 => return Ok(None),
            429 => Some(GitHubActionsFailureKind::RateLimited),
            403 => Some(forbidden_kind(&reply)),
            _ => None,
        };
        if let Some(kind) = kind {
            return Err(GitHubActionsError::Refused {
                kind,
                status: reply.status,
                message: format!(
                    "GitHub Actions observation failed ({}).",
                    reply.status_line()
                ),
            });
        }
        if !reply.ok() {
            return Err(GitHubActionsError::Failed(format!(
                "GitHub Actions request failed ({}).",
                reply.status_line()
            )));
        }

        let parsed = reply.json()?;
        let raw_runs = parsed
            .get("workflow_runs")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let runs = raw_runs.iter().filter_map(normalize_run).collect();
        let has_more = match parsed.get("total_count").and_then(Value::as_u64) {
            Some(total) => u64::from(page) * u64::from(page_size) < total,
            None => raw_runs.len() == page_size as usize,
        };
        Ok(Some(WorkflowRunsPage { runs, has_more }))
    }
}

fn normalize_run(raw: &Value) -> Option<WorkflowRunCandidate> {
    let id = raw.get("id")?.as_u64()?;
    let sha = string_field(raw, "head_sha")?.trim().to_string();
    if sha.is_empty() {
        return None;
    }
    Some(WorkflowRunCandidate {
        id,
        attempt: raw
            .get("run_attempt")
            .and_then(Value::as_u64)
            .and_then(|attempt| u32::try_from(attempt).ok())
            .unwrap_or(1),
        sha,
        workflow_name: string_field(raw, "name").unwrap_or_else(|| "Workflow".to_string()),
        status: string_field(raw, "status").unwrap_or_else(|| "unknown".to_string()),
        conclusion: string_field(raw, "conclusion"),
        created_at: string_field(raw, "created_at")
            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        html_url: string_field(raw, "html_url").unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_http::{MockResponse, MockServer};
    use praxis_trackers::github::GitHubApiConfig;
    use serde_json::json;

    fn observer(base_url: &str) -> GitHubActionsObserver {
        GitHubActionsObserver::new(GitHubApiService::new(GitHubApiConfig {
            base_url: base_url.to_string(),
            owner: "acme".to_string(),
            repo: "demo".to_string(),
            token: "ghp-test".to_string(),
        }))
    }

    fn run(id: u64, sha: &str, status: &str, conclusion: Option<&str>, attempt: u32) -> Value {
        json!({
            "id": id,
            "head_sha": sha,
            "name": "Deploy",
            "status": status,
            "conclusion": conclusion,
            "created_at": "2026-09-09T00:00:00Z",
            "html_url": format!("https://github.com/acme/demo/actions/runs/{id}"),
            "run_attempt": attempt
        })
    }

    fn commit(sha: &str) -> WorkflowEvidenceSourceRef {
        WorkflowEvidenceSourceRef::Commit {
            sha: sha.to_string(),
        }
    }

    async fn serve_runs(runs: Vec<Value>) -> MockServer {
        let body = json!({ "total_count": runs.len(), "workflow_runs": runs });
        MockServer::start(move |_| MockResponse::json(&body)).await
    }

    // ── list_workflow_runs ───────────────────────────────────────────────

    #[tokio::test]
    async fn list_workflow_runs_normalizes_each_run() {
        let server = serve_runs(vec![
            run(101, "abc123", "completed", Some("success"), 1),
            run(100, "def456", "in_progress", None, 1),
        ])
        .await;
        let page = observer(&server.base_url)
            .list_workflow_runs("1", 1, 30)
            .await
            .expect("lists")
            .expect("the workflow exists");
        assert_eq!(page.runs.len(), 2);
        assert!(!page.has_more);
        assert_eq!(
            page.runs[0],
            WorkflowRunCandidate {
                id: 101,
                attempt: 1,
                sha: "abc123".to_string(),
                workflow_name: "Deploy".to_string(),
                status: "completed".to_string(),
                conclusion: Some("success".to_string()),
                created_at: "2026-09-09T00:00:00Z".to_string(),
                html_url: "https://github.com/acme/demo/actions/runs/101".to_string(),
            }
        );
        let request = &server.requests()[0];
        assert_eq!(request.path(), "/repos/acme/demo/actions/workflows/1/runs");
        assert_eq!(request.query_param("per_page").as_deref(), Some("30"));
        assert_eq!(request.query_param("page").as_deref(), Some("1"));
    }

    #[tokio::test]
    async fn a_missing_workflow_lists_as_none() {
        let server = MockServer::start(|_| {
            MockResponse::status_json(404, &json!({ "message": "Not Found" }))
        })
        .await;
        let page = observer(&server.base_url)
            .list_workflow_runs("999", 1, 30)
            .await
            .expect("not an error");
        assert_eq!(page, None);
    }

    #[tokio::test]
    async fn other_errors_are_reported() {
        let server = MockServer::start(|_| {
            MockResponse::status_json(500, &json!({ "message": "Internal Server Error" }))
        })
        .await;
        let error = observer(&server.base_url)
            .list_workflow_runs("1", 1, 30)
            .await
            .expect_err("fails");
        assert!(error.to_string().contains("HTTP 500"));
    }

    // ── correlate_workflow_run ───────────────────────────────────────────

    #[tokio::test]
    async fn exactly_one_matching_run_is_a_single_candidate() {
        let server = serve_runs(vec![
            run(103, "zzz999", "completed", Some("success"), 1),
            run(102, "abc123", "completed", Some("success"), 1),
            run(101, "def456", "in_progress", None, 1),
        ])
        .await;
        let outcome = observer(&server.base_url)
            .correlate_workflow_run("1", &commit("abc123"))
            .await
            .expect("correlates");
        let WorkflowRunCorrelationOutcome::SingleCandidate { run } = outcome else {
            panic!("expected a single candidate, got {outcome:?}");
        };
        assert_eq!(run.id, 102);
        assert_eq!(
            server.requests()[0].query_param("head_sha").as_deref(),
            Some("abc123")
        );
    }

    #[tokio::test]
    async fn several_matching_runs_are_returned_for_selection() {
        let server = serve_runs(vec![
            run(104, "abc123", "completed", Some("failure"), 2),
            run(103, "abc123", "completed", Some("success"), 1),
            run(102, "def456", "completed", Some("success"), 1),
            run(101, "ghi789", "in_progress", None, 1),
        ])
        .await;
        let outcome = observer(&server.base_url)
            .correlate_workflow_run("1", &commit("abc123"))
            .await
            .expect("correlates");
        let WorkflowRunCorrelationOutcome::MultipleCandidates { runs } = outcome else {
            panic!("expected several candidates, got {outcome:?}");
        };
        assert_eq!(runs.iter().map(|r| r.id).collect::<Vec<_>>(), [104, 103]);
    }

    #[tokio::test]
    async fn no_matching_run_has_no_candidates() {
        let server = serve_runs(vec![
            run(102, "def456", "completed", Some("success"), 1),
            run(101, "ghi789", "in_progress", None, 1),
        ])
        .await;
        let outcome = observer(&server.base_url)
            .correlate_workflow_run("1", &commit("abc123"))
            .await
            .expect("correlates");
        assert_eq!(outcome, WorkflowRunCorrelationOutcome::NoCandidates);
    }

    #[tokio::test]
    async fn an_unknown_source_commit_requests_nothing() {
        let server = serve_runs(Vec::new()).await;
        let outcome = observer(&server.base_url)
            .correlate_workflow_run("1", &WorkflowEvidenceSourceRef::Unknown)
            .await
            .expect("correlates");
        assert_eq!(outcome, WorkflowRunCorrelationOutcome::NoCandidates);
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn a_missing_workflow_has_no_candidates() {
        let server = MockServer::start(|_| {
            MockResponse::status_json(404, &json!({ "message": "Not Found" }))
        })
        .await;
        let outcome = observer(&server.base_url)
            .correlate_workflow_run("999", &commit("abc123"))
            .await
            .expect("correlates");
        assert_eq!(outcome, WorkflowRunCorrelationOutcome::NoCandidates);
    }

    #[tokio::test]
    async fn correlation_pages_until_it_has_enough_candidates() {
        let server = MockServer::start(|request| {
            let page: u64 = request
                .query_param("page")
                .and_then(|page| page.parse().ok())
                .unwrap_or(1);
            let runs: Vec<Value> = (0..10)
                .map(|i| run(page * 100 + i, "abc123", "completed", Some("success"), 1))
                .collect();
            MockResponse::json(&json!({ "total_count": 25, "workflow_runs": runs }))
        })
        .await;
        let outcome = observer(&server.base_url)
            .correlate_workflow_run("1", &commit("abc123"))
            .await
            .expect("correlates");
        let WorkflowRunCorrelationOutcome::MultipleCandidates { runs } = outcome else {
            panic!("expected several candidates");
        };
        assert_eq!(runs.len(), 10);
        assert_eq!(server.requests().len(), 1, "one full page is enough");
    }

    // ── Error classification ─────────────────────────────────────────────

    #[tokio::test]
    async fn a_403_without_a_rate_limit_signal_is_insufficient_permission() {
        let server = MockServer::start(|_| {
            MockResponse::status_json(403, &json!({ "message": "Forbidden" }))
        })
        .await;
        let error = observer(&server.base_url)
            .list_workflow_runs("1", 1, 30)
            .await
            .expect_err("refused");
        assert_eq!(
            error.kind(),
            Some(GitHubActionsFailureKind::InsufficientPermission)
        );
    }

    #[tokio::test]
    async fn a_429_is_rate_limited() {
        let server = MockServer::start(|_| {
            MockResponse::status_json(429, &json!({ "message": "Too Many Requests" }))
        })
        .await;
        let error = observer(&server.base_url)
            .list_workflow_runs("1", 1, 30)
            .await
            .expect_err("refused");
        assert_eq!(error.kind(), Some(GitHubActionsFailureKind::RateLimited));
    }

    #[tokio::test]
    async fn a_403_with_no_remaining_rate_limit_is_rate_limited() {
        let server = MockServer::start(|_| {
            MockResponse::status_json(403, &json!({ "message": "API rate limit exceeded" }))
                .with_header("X-RateLimit-Remaining", "0")
        })
        .await;
        let error = observer(&server.base_url)
            .list_workflow_runs("1", 1, 30)
            .await
            .expect_err("refused");
        assert_eq!(error.kind(), Some(GitHubActionsFailureKind::RateLimited));
    }
}
