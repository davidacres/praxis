//! GitHub Actions deployment orchestration (`deployments/githubActionsOrchestrator.ts`
//! port): prepare a run, then observe the already-triggered workflow run it belongs to and
//! attach it.
//!
//! As in the TypeScript, only observe mode is orchestrated; dispatching is the executor's
//! call, and no TypeScript caller composes it into a run yet. `SUPPORTED_EXECUTOR_KINDS`
//! still names only `direct-process`, matching `deploymentProfile.ts`.
//!
//! Deliberate differences from the TypeScript:
//!
//! - An attached run settles from the workflow run's own outcome: a completed, successful
//!   run succeeds, any other completed run fails, and an unfinished one stays `verifying`
//!   until [`settle_github_actions_deployment`] is given its outcome. The TypeScript marks
//!   every attached run `succeeded`, even one still queued or already failed.
//! - A correlation error fails the run. The TypeScript applies `health-failed` to a
//!   `deploying` run, which the reducer ignores, leaving it `deploying` with no reason.
//! - The target lock is held while observing, as the direct orchestrator holds it while
//!   deploying, so a concurrent repeat is refused rather than correlating twice. It is
//!   released on every path. The store and lock registry are locked only per read or write.

use std::sync::{Mutex, PoisonError};

use praxis_trackers::github::GitHubApiService;
use serde::{Deserialize, Serialize};

use crate::deployment_profile::{
    DeploymentProfile, ExecutorRef, PublishedArtifact, WorkflowEvidenceSourceRef,
};
use crate::deployment_run_state::{
    DeploymentRun, DeploymentRunCommand, DeploymentRunStatus, DeploymentTargetLockRegistry,
    LockAcquireResult, LockPolicy, apply_deployment_run_command, target_lock_key,
};
use crate::deployment_run_store::DeploymentRunBackend;
use crate::direct_deployment_orchestrator::{
    DeploymentLinks, SharedRunStore, prepare_direct_deployment, require_run, save, status_name,
};
use crate::github_actions_observer::{
    GitHubActionsObserver, WorkflowRunCandidate, WorkflowRunCorrelationOutcome,
};

/// Creates and persists a fresh run; the same semantics as the direct path's prepare.
pub fn prepare_github_actions_deployment<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    run_id: &str,
    profile: &DeploymentProfile,
    artifact: &PublishedArtifact,
    links: DeploymentLinks,
    now: &impl Fn() -> String,
) -> Result<DeploymentRun, String> {
    prepare_direct_deployment(store, run_id, profile, artifact, links, now)
}

/// A candidate run offered for explicit selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedRunCandidate {
    pub id: u64,
    pub workflow_name: String,
    pub status: String,
    pub html_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserveGitHubActionsDeploymentResult {
    pub attached: bool,
    pub run: DeploymentRun,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Set when several runs matched and one must be chosen explicitly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<ObservedRunCandidate>>,
}

fn not_attached(run: DeploymentRun, reason: String) -> ObserveGitHubActionsDeploymentResult {
    ObserveGitHubActionsDeploymentResult {
        attached: false,
        run,
        reason: Some(reason),
        candidates: None,
    }
}

/// `deploy.yml` from `.github/workflows/deploy.yml`: GitHub accepts a workflow's file name
/// in place of its id.
fn workflow_id(workflow_file: &str) -> &str {
    workflow_file
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(workflow_file)
}

fn sha_label(source: &WorkflowEvidenceSourceRef) -> &str {
    match source {
        WorkflowEvidenceSourceRef::Commit { sha } => sha,
        WorkflowEvidenceSourceRef::Unknown => "unknown",
    }
}

/// The run's external id: `github-actions:<run id>:<attempt>`.
#[must_use]
pub fn github_actions_external_id(run: &WorkflowRunCandidate) -> String {
    format!("github-actions:{}:{}", run.id, run.attempt)
}

/// Correlates a queued run with its already-triggered workflow run. One match is attached;
/// several are returned for explicit selection and the run fails; none fails the run.
/// Refuses (and requests nothing) for a non-GitHub-Actions profile, a locked target, a
/// concurrent repeat, or a run that is not queued.
pub async fn observe_github_actions_deployment<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    locks: &Mutex<DeploymentTargetLockRegistry>,
    api: &GitHubApiService,
    run_id: &str,
    profile: &DeploymentProfile,
    artifact: &PublishedArtifact,
    now: &impl Fn() -> String,
) -> Result<ObserveGitHubActionsDeploymentResult, String> {
    let existing = require_run(store, run_id)?;
    let ExecutorRef::GithubActions { workflow_file, .. } = &profile.executor else {
        let reason = format!(
            "Executor \"{}\" is not github-actions; nothing to observe.",
            profile.executor.kind()
        );
        return Ok(not_attached(existing, reason));
    };

    let lock_key = target_lock_key(&profile.target);
    let lock = locks
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .try_acquire(&lock_key, run_id, LockPolicy::Refuse);
    match lock {
        LockAcquireResult::Refused => {
            return Ok(not_attached(
                existing,
                "Target is locked by another deployment run.".to_string(),
            ));
        }
        LockAcquireResult::AlreadyHeldBySelf => {
            return Ok(not_attached(
                existing,
                "This run is already being observed — repeated click ignored.".to_string(),
            ));
        }
        LockAcquireResult::Acquired | LockAcquireResult::Queued => {}
    }

    let outcome = observe_holding_lock(
        store,
        api,
        existing,
        workflow_id(workflow_file),
        artifact,
        now,
    )
    .await;
    locks
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .release(&lock_key, run_id);
    outcome
}

async fn observe_holding_lock<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    api: &GitHubApiService,
    existing: DeploymentRun,
    workflow_id: &str,
    artifact: &PublishedArtifact,
    now: &impl Fn() -> String,
) -> Result<ObserveGitHubActionsDeploymentResult, String> {
    let started = apply_deployment_run_command(
        existing.clone(),
        DeploymentRunCommand::StartDeploying { at: now() },
    );
    if started == existing {
        let reason = format!(
            "Run status is \"{}\", not queued; nothing to observe.",
            status_name(existing.status)
        );
        return Ok(not_attached(existing, reason));
    }
    save(store, &started)?;

    let correlation = GitHubActionsObserver::new(api.clone())
        .correlate_workflow_run(workflow_id, &artifact.source_commit)
        .await;
    let sha = sha_label(&artifact.source_commit);
    let fail = |error: String| -> Result<DeploymentRun, String> {
        let verifying = apply_deployment_run_command(
            started.clone(),
            DeploymentRunCommand::StartVerifying { at: now() },
        );
        let failed = apply_deployment_run_command(
            verifying,
            DeploymentRunCommand::HealthFailed { at: now(), error },
        );
        save(store, &failed)?;
        Ok(failed)
    };

    match correlation {
        Err(error) => {
            let failed = fail(error.to_string())?;
            let reason = format!(
                "Failed to correlate workflow run: {}",
                failed.ended_reason.clone().unwrap_or_default()
            );
            Ok(not_attached(failed, reason))
        }
        Ok(WorkflowRunCorrelationOutcome::SingleCandidate { run }) => {
            let attached = apply_deployment_run_command(
                started.clone(),
                DeploymentRunCommand::RecordExternalId {
                    at: now(),
                    external_id: github_actions_external_id(&run),
                },
            );
            let verifying = apply_deployment_run_command(
                attached,
                DeploymentRunCommand::StartVerifying { at: now() },
            );
            let (current, reason) = settle_from_workflow_run(verifying, &run, now);
            save(store, &current)?;
            Ok(ObserveGitHubActionsDeploymentResult {
                attached: true,
                run: current,
                reason,
                candidates: None,
            })
        }
        Ok(WorkflowRunCorrelationOutcome::MultipleCandidates { runs }) => {
            let failed = fail(format!(
                "Multiple workflow runs found for SHA {sha}; explicit selection required."
            ))?;
            Ok(ObserveGitHubActionsDeploymentResult {
                attached: false,
                run: failed,
                reason: Some("Multiple candidates found".to_string()),
                candidates: Some(
                    runs.into_iter()
                        .map(|run| ObservedRunCandidate {
                            id: run.id,
                            workflow_name: run.workflow_name,
                            status: run.status,
                            html_url: run.html_url,
                        })
                        .collect(),
                ),
            })
        }
        Ok(WorkflowRunCorrelationOutcome::NoCandidates) => {
            let failed = fail(format!(
                "No workflow run found matching the artifact's source commit ({sha})."
            ))?;
            Ok(not_attached(
                failed,
                "No workflow run found for this commit SHA".to_string(),
            ))
        }
    }
}

/// Settles a `verifying` run from its workflow run: completed and successful succeeds, any
/// other completed run fails, and an unfinished one is left `verifying` with a reason.
fn settle_from_workflow_run(
    run: DeploymentRun,
    workflow_run: &WorkflowRunCandidate,
    now: &impl Fn() -> String,
) -> (DeploymentRun, Option<String>) {
    if workflow_run.status != "completed" {
        let reason = format!(
            "Workflow run {} is {}; waiting for it to conclude.",
            workflow_run.id, workflow_run.status
        );
        return (run, Some(reason));
    }
    let settled = match workflow_run.conclusion.as_deref() {
        Some("success") => {
            apply_deployment_run_command(run, DeploymentRunCommand::HealthVerified { at: now() })
        }
        conclusion => apply_deployment_run_command(
            run,
            DeploymentRunCommand::HealthFailed {
                at: now(),
                error: format!(
                    "Workflow run {} concluded {}.",
                    workflow_run.id,
                    conclusion.unwrap_or("without a conclusion")
                ),
            },
        ),
    };
    (settled, None)
}

/// Settles an attached run once its workflow run has an outcome (for example from a later
/// [`GitHubActionsObserver::list_workflow_runs`]). Changes nothing unless the run is
/// `verifying` and attached to exactly this workflow run and attempt.
pub fn settle_github_actions_deployment<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    run_id: &str,
    workflow_run: &WorkflowRunCandidate,
    now: &impl Fn() -> String,
) -> Result<DeploymentRun, String> {
    let existing = require_run(store, run_id)?;
    if existing.status != DeploymentRunStatus::Verifying
        || existing.external_id.as_deref()
            != Some(github_actions_external_id(workflow_run).as_str())
    {
        return Ok(existing);
    }
    let (settled, _) = settle_from_workflow_run(existing.clone(), workflow_run, now);
    if settled != existing {
        save(store, &settled)?;
    }
    Ok(settled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment_profile::{
        ArtifactLocation, DeploymentRollbackKind, DeploymentRollbackPolicy, TargetRef,
    };
    use crate::deployment_run_store::DeploymentRunStore;
    use crate::mock_http::{MockResponse, MockServer};
    use praxis_trackers::github::GitHubApiConfig;
    use serde_json::{Value, json};
    use std::cell::Cell;

    #[derive(Default)]
    struct Memory(Option<Value>);

    impl DeploymentRunBackend for Memory {
        fn read(&self) -> Option<Value> {
            self.0.clone()
        }
        fn write(&mut self, value: Value) -> Result<(), String> {
            self.0 = Some(value);
            Ok(())
        }
    }

    fn store() -> SharedRunStore<Memory> {
        Mutex::new(DeploymentRunStore::new(Memory::default()))
    }

    fn locks() -> Mutex<DeploymentTargetLockRegistry> {
        Mutex::new(DeploymentTargetLockRegistry::new())
    }

    fn clock() -> impl Fn() -> String {
        let tick = Cell::new(0u32);
        move || {
            tick.set(tick.get() + 1);
            format!("2026-09-09T01:00:{:02}.000Z", tick.get() % 60)
        }
    }

    fn profile() -> DeploymentProfile {
        DeploymentProfile {
            schema_version: 1,
            id: "prof-1".to_string(),
            version: 1,
            name: "Deploy to staging".to_string(),
            project_id: "proj-1".to_string(),
            environment: "staging".to_string(),
            executor: ExecutorRef::GithubActions {
                workflow_file: ".github/workflows/deploy.yml".to_string(),
                observe_only: Some(true),
            },
            target: TargetRef::Directory {
                path: ".".to_string(),
            },
            health_check: None,
            rollback: DeploymentRollbackPolicy {
                kind: DeploymentRollbackKind::None,
                retain_count: None,
            },
            credentials: None,
            created_at: "2026-09-09T00:00:00Z".to_string(),
            updated_at: "2026-09-09T00:00:00Z".to_string(),
        }
    }

    fn artifact() -> PublishedArtifact {
        PublishedArtifact {
            id: "art-1".to_string(),
            deployment_profile_id: "prof-1".to_string(),
            source_commit: WorkflowEvidenceSourceRef::Commit {
                sha: "abc123".to_string(),
            },
            digest: "sha256:deadbeef".to_string(),
            created_at: "2026-09-09T00:00:00Z".to_string(),
            location: ArtifactLocation::LocalPath {
                path: "/tmp/artifact".to_string(),
            },
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

    fn workflow_run(id: u64, sha: &str, status: &str, conclusion: Option<&str>) -> Value {
        json!({
            "id": id,
            "head_sha": sha,
            "name": "Deploy",
            "status": status,
            "conclusion": conclusion,
            "created_at": "2026-09-09T00:00:00Z",
            "html_url": format!("https://github.com/acme/demo/actions/runs/{id}"),
            "run_attempt": 1
        })
    }

    async fn serve_runs(runs: Vec<Value>) -> MockServer {
        let body = json!({ "total_count": runs.len(), "workflow_runs": runs });
        MockServer::start(move |request| {
            if request.path().contains("/workflows/") {
                MockResponse::json(&body)
            } else {
                MockResponse::text(404, "{}")
            }
        })
        .await
    }

    /// Prepares and approves `run-1`, leaving it queued.
    fn prepared_and_approved(store: &SharedRunStore<Memory>) -> DeploymentRun {
        let run = prepare_github_actions_deployment(
            store,
            "run-1",
            &profile(),
            &artifact(),
            DeploymentLinks::default(),
            &|| "2026-09-09T00:00:00Z".to_string(),
        )
        .expect("prepared");
        let run = apply_deployment_run_command(
            run,
            DeploymentRunCommand::RequestApproval {
                at: "2026-09-09T00:00:01Z".to_string(),
            },
        );
        let run = apply_deployment_run_command(
            run,
            DeploymentRunCommand::Approve {
                at: "2026-09-09T00:00:02Z".to_string(),
                by: "test".to_string(),
            },
        );
        save(store, &run).expect("saved");
        run
    }

    async fn observe(
        store: &SharedRunStore<Memory>,
        locks: &Mutex<DeploymentTargetLockRegistry>,
        base_url: &str,
    ) -> ObserveGitHubActionsDeploymentResult {
        observe_github_actions_deployment(
            store,
            locks,
            &api(base_url),
            "run-1",
            &profile(),
            &artifact(),
            &clock(),
        )
        .await
        .expect("observed")
    }

    #[test]
    fn prepare_creates_and_persists_a_prepared_run() {
        let store = store();
        let run = prepare_github_actions_deployment(
            &store,
            "run-1",
            &profile(),
            &artifact(),
            DeploymentLinks::default(),
            &|| "2026-09-09T00:00:00Z".to_string(),
        )
        .expect("prepared");
        assert_eq!(run.status, DeploymentRunStatus::Prepared);
        assert_eq!(run.deployment_profile_id, "prof-1");
        assert_eq!(run.artifact_id, "art-1");
        assert_eq!(
            require_run(&store, "run-1").expect("stored").status,
            DeploymentRunStatus::Prepared
        );
    }

    #[tokio::test]
    async fn one_completed_successful_run_is_attached_and_succeeds() {
        let (store, locks) = (store(), locks());
        prepared_and_approved(&store);
        let server = serve_runs(vec![workflow_run(
            101,
            "abc123",
            "completed",
            Some("success"),
        )])
        .await;
        let result = observe(&store, &locks, &server.base_url).await;
        assert!(result.attached);
        assert_eq!(result.run.status, DeploymentRunStatus::Succeeded);
        assert_eq!(
            result.run.external_id.as_deref(),
            Some("github-actions:101:1")
        );
        assert_eq!(require_run(&store, "run-1").expect("stored"), result.run);
        assert_eq!(locks.lock().expect("locks").holder_of("directory:."), None);
        assert_eq!(
            server.requests()[0].path(),
            "/repos/acme/demo/actions/workflows/deploy.yml/runs"
        );
    }

    #[tokio::test]
    async fn an_attached_run_that_failed_fails_the_deployment() {
        let (store, locks) = (store(), locks());
        prepared_and_approved(&store);
        let server = serve_runs(vec![workflow_run(
            101,
            "abc123",
            "completed",
            Some("failure"),
        )])
        .await;
        let result = observe(&store, &locks, &server.base_url).await;
        assert!(result.attached);
        assert_eq!(result.run.status, DeploymentRunStatus::Failed);
        assert_eq!(
            result.run.ended_reason.as_deref(),
            Some("Workflow run 101 concluded failure.")
        );
    }

    #[tokio::test]
    async fn an_unfinished_run_is_attached_and_settled_later() {
        let (store, locks) = (store(), locks());
        prepared_and_approved(&store);
        let server = serve_runs(vec![workflow_run(101, "abc123", "queued", None)]).await;
        let result = observe(&store, &locks, &server.base_url).await;
        assert!(result.attached);
        assert_eq!(result.run.status, DeploymentRunStatus::Verifying);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("waiting"))
        );

        let mut finished: WorkflowRunCandidate = serde_json::from_value(json!({
            "id": 102, "attempt": 1, "sha": "abc123", "workflowName": "Deploy",
            "status": "completed", "conclusion": "success",
            "createdAt": "2026-09-09T00:00:00Z", "htmlUrl": ""
        }))
        .expect("candidate");
        let unrelated =
            settle_github_actions_deployment(&store, "run-1", &finished, &clock()).expect("settle");
        assert_eq!(
            unrelated.status,
            DeploymentRunStatus::Verifying,
            "a different workflow run settles nothing"
        );
        finished.id = 101;
        let settled =
            settle_github_actions_deployment(&store, "run-1", &finished, &clock()).expect("settle");
        assert_eq!(settled.status, DeploymentRunStatus::Succeeded);
        assert_eq!(require_run(&store, "run-1").expect("stored"), settled);
    }

    #[tokio::test]
    async fn several_matching_runs_are_returned_for_selection() {
        let (store, locks) = (store(), locks());
        prepared_and_approved(&store);
        let server = serve_runs(vec![
            workflow_run(102, "abc123", "completed", Some("failure")),
            workflow_run(101, "abc123", "completed", Some("success")),
        ])
        .await;
        let result = observe(&store, &locks, &server.base_url).await;
        assert!(!result.attached);
        assert_eq!(result.run.status, DeploymentRunStatus::Failed);
        let candidates = result.candidates.expect("candidates");
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].id, 102);
    }

    #[tokio::test]
    async fn no_matching_run_fails_the_deployment() {
        let (store, locks) = (store(), locks());
        prepared_and_approved(&store);
        let server = serve_runs(vec![
            workflow_run(201, "def456", "completed", Some("success")),
            workflow_run(200, "ghi789", "completed", Some("success")),
        ])
        .await;
        let result = observe(&store, &locks, &server.base_url).await;
        assert!(!result.attached);
        assert_eq!(result.run.status, DeploymentRunStatus::Failed);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("No workflow run found"))
        );
    }

    #[tokio::test]
    async fn a_correlation_error_fails_the_run_with_its_reason() {
        let (store, locks) = (store(), locks());
        prepared_and_approved(&store);
        let server = MockServer::start(|_| MockResponse::text(500, "{}")).await;
        let result = observe(&store, &locks, &server.base_url).await;
        assert!(!result.attached);
        assert_eq!(result.run.status, DeploymentRunStatus::Failed);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("HTTP 500"))
        );
        assert!(!result.reason.unwrap_or_default().contains("ghp-test"));
        assert_eq!(locks.lock().expect("locks").holder_of("directory:."), None);
    }

    #[tokio::test]
    async fn an_in_flight_run_is_left_alone_and_nothing_is_requested() {
        let (store, locks) = (store(), locks());
        let run = prepared_and_approved(&store);
        let deploying = apply_deployment_run_command(
            run,
            DeploymentRunCommand::StartDeploying {
                at: "2026-09-09T00:01:00Z".to_string(),
            },
        );
        save(&store, &deploying).expect("saved");
        let server = serve_runs(Vec::new()).await;
        let result = observe(&store, &locks, &server.base_url).await;
        assert!(!result.attached);
        assert_eq!(result.run.status, DeploymentRunStatus::Deploying);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("not queued"))
        );
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn a_locked_target_is_refused_and_the_other_holder_keeps_it() {
        let (store, locks) = (store(), locks());
        prepared_and_approved(&store);
        locks
            .lock()
            .expect("locks")
            .try_acquire("directory:.", "run-other", LockPolicy::Refuse);
        let server = serve_runs(Vec::new()).await;
        let result = observe(&store, &locks, &server.base_url).await;
        assert!(!result.attached);
        assert_eq!(result.run.status, DeploymentRunStatus::Queued);
        assert!(server.requests().is_empty());
        assert_eq!(
            locks.lock().expect("locks").holder_of("directory:."),
            Some("run-other")
        );
    }

    #[tokio::test]
    async fn a_non_github_actions_profile_is_refused() {
        let (store, locks) = (store(), locks());
        prepared_and_approved(&store);
        let direct = DeploymentProfile {
            executor: ExecutorRef::DirectProcess,
            ..profile()
        };
        let result = observe_github_actions_deployment(
            &store,
            &locks,
            &api("http://127.0.0.1:9"),
            "run-1",
            &direct,
            &artifact(),
            &clock(),
        )
        .await
        .expect("observed");
        assert!(!result.attached);
        assert_eq!(result.run.status, DeploymentRunStatus::Queued);
    }

    #[test]
    fn the_workflow_id_is_the_workflow_files_name() {
        assert_eq!(workflow_id(".github/workflows/deploy.yml"), "deploy.yml");
        assert_eq!(workflow_id("deploy.yml"), "deploy.yml");
    }
}
