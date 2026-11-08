//! Durable deployment run state and event log (`projects/deploymentRunState.ts` port).
//!
//! A run is a reduced value: every transition is a pure `(run, command) -> run` step that
//! appends to an event log, and replaying a command the run already absorbed returns it
//! unchanged ("completed steps are not replayed"). The transition table itself enforces:
//!
//! - only `health-verified` fired from `verifying` reaches `succeeded`;
//! - `cancelled` and `rolled-back` absorb nothing further, and `succeeded`/`failed` accept
//!   only a rollback or (for `failed`) a dispatch retry;
//! - a crash mid-flight reconciles to `unknown`, never silently to `succeeded`.
//!
//! Approval validity and target locking are separate functions, because they compare
//! against current state the reducer never sees.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::deployment_profile::{DeploymentProfile, PublishedArtifact, TargetRef};

pub const DEPLOYMENT_RUN_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeploymentRunStatus {
    Prepared,
    AwaitingApproval,
    Queued,
    Deploying,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
    RollingBack,
    RolledBack,
}

impl DeploymentRunStatus {
    /// Parses the kebab-case name the TypeScript stores.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(value.to_string())).ok()
    }
}

#[must_use]
pub fn is_deployment_run_settled(run: &DeploymentRun) -> bool {
    matches!(
        run.status,
        DeploymentRunStatus::Succeeded
            | DeploymentRunStatus::Failed
            | DeploymentRunStatus::Cancelled
            | DeploymentRunStatus::RolledBack
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeploymentRunEventKind {
    Prepared,
    ApprovalRequested,
    Approved,
    ApprovalInvalidated,
    Enqueued,
    DeployStarted,
    VerifyStarted,
    HealthVerified,
    HealthFailed,
    Cancelled,
    MarkedUnknown,
    RollbackStarted,
    RolledBack,
    RollbackFailed,
    ExternalIdRecorded,
    DispatchRetried,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeploymentRunEvent {
    /// `<runId>-<sequence>`; the sequence is the log length at append time.
    pub id: String,
    pub at: String,
    pub kind: DeploymentRunEventKind,
    pub message: String,
}

/// Binds an approval to exactly the profile version, artifact digest and environment it
/// was granted against. [`is_approval_valid`] re-checks all of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentApproval {
    pub deployment_profile_id: String,
    pub profile_version: u32,
    pub artifact_id: String,
    pub artifact_digest: String,
    pub environment: String,
    pub approved_by: String,
    pub approved_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentRun {
    pub schema_version: u32,
    pub run_id: String,
    pub deployment_profile_id: String,
    /// The profile version and artifact this run was prepared against, embedded so a later
    /// profile edit never rewrites an in-flight run's history.
    pub profile_version: u32,
    pub environment: String,
    pub artifact_id: String,
    pub artifact_digest: String,
    pub status: DeploymentRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<DeploymentApproval>,
    /// 1-based; bumped only by `retry-dispatch`.
    pub attempt: u32,
    /// The dispatched operation's identity once known (a pid for the direct executor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    pub events: Vec<DeploymentRunEvent>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_reason: Option<String>,
    /// Linking context, set once at prepare time and never changed by a command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateDeploymentRunInput {
    pub run_id: String,
    pub deployment_profile_id: String,
    pub profile_version: u32,
    pub environment: String,
    pub artifact_id: String,
    pub artifact_digest: String,
    pub at: String,
    pub issue_key: Option<String>,
    pub issue_connection_id: Option<String>,
    pub workflow_run_id: Option<String>,
    pub target_url: Option<String>,
}

/// An empty string is treated as absent, as the TypeScript's truthiness checks do.
fn present(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

#[must_use]
pub fn create_deployment_run(input: CreateDeploymentRunInput) -> DeploymentRun {
    let at = input.at.clone();
    let run = DeploymentRun {
        schema_version: DEPLOYMENT_RUN_SCHEMA_VERSION,
        run_id: input.run_id,
        deployment_profile_id: input.deployment_profile_id,
        profile_version: input.profile_version,
        environment: input.environment,
        artifact_id: input.artifact_id,
        artifact_digest: input.artifact_digest,
        status: DeploymentRunStatus::Prepared,
        approval: None,
        attempt: 1,
        external_id: None,
        events: Vec::new(),
        started_at: input.at,
        ended_at: None,
        ended_reason: None,
        issue_key: present(input.issue_key),
        issue_connection_id: present(input.issue_connection_id),
        workflow_run_id: present(input.workflow_run_id),
        target_url: present(input.target_url),
    };
    append(
        run,
        at,
        DeploymentRunEventKind::Prepared,
        "Deployment prepared.".to_string(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DeploymentRunCommand {
    RequestApproval {
        at: String,
    },
    Approve {
        at: String,
        by: String,
    },
    InvalidateApproval {
        at: String,
        reason: String,
    },
    Enqueue {
        at: String,
    },
    StartDeploying {
        at: String,
    },
    StartVerifying {
        at: String,
    },
    HealthVerified {
        at: String,
    },
    HealthFailed {
        at: String,
        error: String,
    },
    Cancel {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    MarkUnknown {
        at: String,
        reason: String,
    },
    StartRollback {
        at: String,
    },
    RollbackSucceeded {
        at: String,
    },
    RollbackFailed {
        at: String,
        error: String,
    },
    #[serde(rename_all = "camelCase")]
    RecordExternalId {
        at: String,
        external_id: String,
    },
    RetryDispatch {
        at: String,
    },
}

/// The one reducer. Each command checks its own allowed source status; a command that
/// doesn't apply returns the run unchanged, so a caller unsure whether a command was
/// applied can simply re-send it.
#[must_use]
pub fn apply_deployment_run_command(
    run: DeploymentRun,
    command: DeploymentRunCommand,
) -> DeploymentRun {
    use DeploymentRunEventKind as Event;
    use DeploymentRunStatus as Status;

    // Truly terminal: nothing, rollback included, acts on these again.
    if matches!(run.status, Status::Cancelled | Status::RolledBack) {
        return run;
    }

    match command {
        DeploymentRunCommand::RequestApproval { at } => transition(
            run,
            &[Status::Prepared],
            Status::AwaitingApproval,
            at,
            Event::ApprovalRequested,
            "Approval requested.",
        ),
        DeploymentRunCommand::Approve { at, by } => {
            if run.status != Status::AwaitingApproval {
                return run;
            }
            let approval = DeploymentApproval {
                deployment_profile_id: run.deployment_profile_id.clone(),
                profile_version: run.profile_version,
                artifact_id: run.artifact_id.clone(),
                artifact_digest: run.artifact_digest.clone(),
                environment: run.environment.clone(),
                approved_by: by.clone(),
                approved_at: at.clone(),
            };
            let run = DeploymentRun {
                status: Status::Queued,
                approval: Some(approval),
                ..run
            };
            append(run, at, Event::Approved, format!("Approved by {by}."))
        }
        DeploymentRunCommand::InvalidateApproval { at, reason } => {
            // Only meaningful once approval is in play; otherwise a no-op, not an error.
            if !matches!(run.status, Status::Queued | Status::AwaitingApproval) {
                return run;
            }
            let run = DeploymentRun {
                status: Status::AwaitingApproval,
                approval: None,
                ..run
            };
            append(
                run,
                at,
                Event::ApprovalInvalidated,
                format!("Approval invalidated: {reason}"),
            )
        }
        DeploymentRunCommand::Enqueue { at } => transition(
            run,
            &[Status::Queued],
            Status::Queued,
            at,
            Event::Enqueued,
            "Queued — waiting for its target to be free.",
        ),
        DeploymentRunCommand::StartDeploying { at } => {
            // Refuses without an attached approval. Whether that approval still matches the
            // current profile and artifact is the caller's `is_approval_valid` check.
            if run.status != Status::Queued || run.approval.is_none() {
                return run;
            }
            let run = DeploymentRun {
                status: Status::Deploying,
                ..run
            };
            append(
                run,
                at,
                Event::DeployStarted,
                "Deployment started.".to_string(),
            )
        }
        DeploymentRunCommand::StartVerifying { at } => transition(
            run,
            &[Status::Deploying],
            Status::Verifying,
            at,
            Event::VerifyStarted,
            "Verifying deployed health.",
        ),
        DeploymentRunCommand::HealthVerified { at } => {
            if run.status != Status::Verifying {
                return run;
            }
            settle(
                run,
                Status::Succeeded,
                at,
                Event::HealthVerified,
                "Health verified — deployment succeeded.".to_string(),
                None,
            )
        }
        DeploymentRunCommand::HealthFailed { at, error } => {
            if run.status != Status::Verifying {
                return run;
            }
            settle(
                run,
                Status::Failed,
                at,
                Event::HealthFailed,
                format!("Health check failed: {error}"),
                Some(error),
            )
        }
        DeploymentRunCommand::Cancel { at, reason } => {
            if !matches!(
                run.status,
                Status::Prepared
                    | Status::AwaitingApproval
                    | Status::Queued
                    | Status::Deploying
                    | Status::Verifying
            ) {
                return run;
            }
            let reason = present(reason);
            let message = reason
                .as_ref()
                .map_or_else(|| "Cancelled.".to_string(), |r| format!("Cancelled: {r}"));
            settle(
                run,
                Status::Cancelled,
                at,
                Event::Cancelled,
                message,
                reason,
            )
        }
        DeploymentRunCommand::MarkUnknown { at, reason } => {
            // Idempotent once reached, and only meaningful mid-flight.
            if !matches!(run.status, Status::Deploying | Status::Verifying) {
                return run;
            }
            let run = DeploymentRun {
                status: Status::Unknown,
                ..run
            };
            append(
                run,
                at,
                Event::MarkedUnknown,
                format!("Status unknown: {reason}"),
            )
        }
        DeploymentRunCommand::StartRollback { at } => transition(
            run,
            &[Status::Succeeded, Status::Failed],
            Status::RollingBack,
            at,
            Event::RollbackStarted,
            "Rolling back.",
        ),
        DeploymentRunCommand::RollbackSucceeded { at } => {
            if run.status != Status::RollingBack {
                return run;
            }
            settle(
                run,
                Status::RolledBack,
                at,
                Event::RolledBack,
                "Rollback succeeded.".to_string(),
                None,
            )
        }
        DeploymentRunCommand::RollbackFailed { at, error } => {
            if run.status != Status::RollingBack {
                return run;
            }
            // Lands back on `failed`: "rolled-back" would misreport what happened.
            settle(
                run,
                Status::Failed,
                at,
                Event::RollbackFailed,
                format!("Rollback failed: {error}"),
                Some(error),
            )
        }
        DeploymentRunCommand::RecordExternalId { at, external_id } => {
            if !matches!(run.status, Status::Deploying | Status::Verifying)
                || run.external_id.as_deref() == Some(external_id.as_str())
            {
                return run;
            }
            let message = format!("External id recorded: {external_id}");
            let run = DeploymentRun {
                external_id: Some(external_id),
                ..run
            };
            append(run, at, Event::ExternalIdRecorded, message)
        }
        DeploymentRunCommand::RetryDispatch { at } => {
            // Reuses the original approval; the caller re-checks it before retrying.
            if !matches!(run.status, Status::Unknown | Status::Failed) || run.approval.is_none() {
                return run;
            }
            let attempt = run.attempt + 1;
            let run = DeploymentRun {
                status: Status::Queued,
                attempt,
                ended_at: None,
                ended_reason: None,
                external_id: None,
                ..run
            };
            append(
                run,
                at,
                Event::DispatchRetried,
                format!("Retrying — attempt {attempt}."),
            )
        }
    }
}

fn transition(
    run: DeploymentRun,
    allowed_from: &[DeploymentRunStatus],
    to: DeploymentRunStatus,
    at: String,
    kind: DeploymentRunEventKind,
    message: &str,
) -> DeploymentRun {
    if !allowed_from.contains(&run.status) {
        return run;
    }
    let run = DeploymentRun { status: to, ..run };
    append(run, at, kind, message.to_string())
}

fn settle(
    run: DeploymentRun,
    status: DeploymentRunStatus,
    at: String,
    kind: DeploymentRunEventKind,
    message: String,
    ended_reason: Option<String>,
) -> DeploymentRun {
    let ended_reason = present(ended_reason).or(run.ended_reason.clone());
    let run = DeploymentRun {
        status,
        ended_at: Some(at.clone()),
        ended_reason,
        ..run
    };
    append(run, at, kind, message)
}

fn append(
    mut run: DeploymentRun,
    at: String,
    kind: DeploymentRunEventKind,
    message: String,
) -> DeploymentRun {
    let id = format!("{}-{}", run.run_id, run.events.len());
    run.events.push(DeploymentRunEvent {
        id,
        at,
        kind,
        message,
    });
    run
}

/// Whether an approval still covers what is about to deploy. The profile version is bumped
/// on any edit, target included, so comparing it catches a target change.
#[must_use]
pub fn is_approval_valid(
    approval: &DeploymentApproval,
    profile: &DeploymentProfile,
    artifact: &PublishedArtifact,
) -> bool {
    approval.deployment_profile_id == profile.id
        && approval.profile_version == profile.version
        && approval.artifact_id == artifact.id
        && approval.artifact_digest == artifact.digest
        && approval.environment == profile.environment
}

/// A stable identity for one physical destination, so two profiles naming it contend for
/// the same lock.
#[must_use]
pub fn target_lock_key(target: &TargetRef) -> String {
    match target {
        TargetRef::Directory { path } => format!("directory:{path}"),
        TargetRef::LocalProcess {
            executable, cwd, ..
        } => format!(
            "local-process:{executable}:{}",
            cwd.as_deref().unwrap_or("")
        ),
        TargetRef::Iis { site_name, .. } => format!("iis:{site_name}"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LockAcquireResult {
    Acquired,
    Queued,
    Refused,
    AlreadyHeldBySelf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LockPolicy {
    /// Wait in line behind the current holder.
    #[default]
    Queue,
    /// Fail fast instead of waiting.
    Refuse,
}

/// In-memory target locks: a concurrent deployment to a locked target is queued or refused
/// explicitly, never run alongside the holder.
#[derive(Debug, Default)]
pub struct DeploymentTargetLockRegistry {
    holders: BTreeMap<String, String>,
    queues: BTreeMap<String, VecDeque<String>>,
}

impl DeploymentTargetLockRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn try_acquire(
        &mut self,
        lock_key: &str,
        run_id: &str,
        policy: LockPolicy,
    ) -> LockAcquireResult {
        match self.holders.get(lock_key) {
            Some(holder) if holder == run_id => LockAcquireResult::AlreadyHeldBySelf,
            None => {
                self.holders
                    .insert(lock_key.to_string(), run_id.to_string());
                LockAcquireResult::Acquired
            }
            Some(_) if policy == LockPolicy::Refuse => LockAcquireResult::Refused,
            Some(_) => {
                let queue = self.queues.entry(lock_key.to_string()).or_default();
                if !queue.iter().any(|queued| queued == run_id) {
                    queue.push_back(run_id.to_string());
                }
                LockAcquireResult::Queued
            }
        }
    }

    /// Releases the lock. If a run was queued for it, that run now holds it and its id is
    /// returned so the caller can advance it. A release by a non-holder does nothing.
    pub fn release(&mut self, lock_key: &str, run_id: &str) -> Option<String> {
        if self.holders.get(lock_key).map(String::as_str) != Some(run_id) {
            return None;
        }
        self.holders.remove(lock_key);
        let next = self.queues.get_mut(lock_key).and_then(VecDeque::pop_front);
        match &next {
            Some(next_run) => {
                self.holders.insert(lock_key.to_string(), next_run.clone());
                if self.queues.get(lock_key).is_some_and(VecDeque::is_empty) {
                    self.queues.remove(lock_key);
                }
            }
            None => {
                self.queues.remove(lock_key);
            }
        }
        next
    }

    /// Drops a queued run (e.g. one cancelled before its turn) without touching the holder.
    pub fn remove_from_queue(&mut self, lock_key: &str, run_id: &str) {
        if let Some(queue) = self.queues.get_mut(lock_key) {
            queue.retain(|queued| queued != run_id);
            if queue.is_empty() {
                self.queues.remove(lock_key);
            }
        }
    }

    #[must_use]
    pub fn holder_of(&self, lock_key: &str) -> Option<&str> {
        self.holders.get(lock_key).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment_profile::{
        ArtifactLocation, DeploymentRollbackKind, DeploymentRollbackPolicy, ExecutorRef,
        WorkflowEvidenceSourceRef,
    };
    use std::cell::Cell;

    const AT: &str = "2026-09-09T00:00:00.000Z";

    thread_local! {
        static CLOCK: Cell<u32> = const { Cell::new(0) };
    }

    fn next_at() -> String {
        let tick = CLOCK.with(|clock| {
            clock.set(clock.get() + 1);
            clock.get()
        });
        format!("2026-09-09T00:{tick:02}:00.000Z")
    }

    fn input() -> CreateDeploymentRunInput {
        CreateDeploymentRunInput {
            run_id: "run-1".to_string(),
            deployment_profile_id: "production".to_string(),
            profile_version: 1,
            environment: "production".to_string(),
            artifact_id: "artifact-1".to_string(),
            artifact_digest: "sha256:abc".to_string(),
            at: AT.to_string(),
            ..CreateDeploymentRunInput::default()
        }
    }

    fn run() -> DeploymentRun {
        create_deployment_run(input())
    }

    fn apply(run: DeploymentRun, command: DeploymentRunCommand) -> DeploymentRun {
        apply_deployment_run_command(run, command)
    }

    fn request_approval(r: DeploymentRun) -> DeploymentRun {
        apply(r, DeploymentRunCommand::RequestApproval { at: next_at() })
    }

    fn approve(r: DeploymentRun) -> DeploymentRun {
        apply(
            r,
            DeploymentRunCommand::Approve {
                at: next_at(),
                by: "alice".to_string(),
            },
        )
    }

    fn start_verifying(r: DeploymentRun) -> DeploymentRun {
        apply(r, DeploymentRunCommand::StartVerifying { at: next_at() })
    }

    fn health_verified(r: DeploymentRun) -> DeploymentRun {
        apply(r, DeploymentRunCommand::HealthVerified { at: next_at() })
    }

    fn health_failed(r: DeploymentRun, error: &str) -> DeploymentRun {
        apply(
            r,
            DeploymentRunCommand::HealthFailed {
                at: next_at(),
                error: error.to_string(),
            },
        )
    }

    fn mark_unknown(r: DeploymentRun, reason: &str) -> DeploymentRun {
        apply(
            r,
            DeploymentRunCommand::MarkUnknown {
                at: next_at(),
                reason: reason.to_string(),
            },
        )
    }

    fn record_external_id(r: DeploymentRun, id: &str) -> DeploymentRun {
        apply(
            r,
            DeploymentRunCommand::RecordExternalId {
                at: next_at(),
                external_id: id.to_string(),
            },
        )
    }

    fn retry(r: DeploymentRun) -> DeploymentRun {
        apply(r, DeploymentRunCommand::RetryDispatch { at: next_at() })
    }

    fn to_deploying() -> DeploymentRun {
        let r = approve(request_approval(run()));
        apply(r, DeploymentRunCommand::StartDeploying { at: next_at() })
    }

    fn profile() -> DeploymentProfile {
        DeploymentProfile {
            schema_version: 1,
            version: 1,
            id: "production".to_string(),
            name: "Production".to_string(),
            project_id: "proj-1".to_string(),
            environment: "production".to_string(),
            executor: ExecutorRef::DirectProcess,
            target: TargetRef::Directory {
                path: "dist".to_string(),
            },
            health_check: None,
            rollback: DeploymentRollbackPolicy {
                kind: DeploymentRollbackKind::None,
                retain_count: None,
            },
            credentials: None,
            created_at: AT.to_string(),
            updated_at: AT.to_string(),
        }
    }

    fn artifact(id: &str, digest: &str) -> PublishedArtifact {
        PublishedArtifact {
            id: id.to_string(),
            deployment_profile_id: "production".to_string(),
            source_commit: WorkflowEvidenceSourceRef::Commit {
                sha: "abc".to_string(),
            },
            digest: digest.to_string(),
            created_at: AT.to_string(),
            location: ArtifactLocation::LocalPath {
                path: "/tmp/dist".to_string(),
            },
        }
    }

    fn approval() -> DeploymentApproval {
        DeploymentApproval {
            deployment_profile_id: "production".to_string(),
            profile_version: 1,
            artifact_id: "artifact-1".to_string(),
            artifact_digest: "sha256:abc".to_string(),
            environment: "production".to_string(),
            approved_by: "alice".to_string(),
            approved_at: AT.to_string(),
        }
    }

    fn dir_key(path: &str) -> String {
        target_lock_key(&TargetRef::Directory {
            path: path.to_string(),
        })
    }

    #[test]
    fn a_fresh_run_starts_prepared_at_attempt_one_with_no_external_id() {
        let r = run();
        assert_eq!(r.status, DeploymentRunStatus::Prepared);
        assert_eq!(r.attempt, 1);
        assert_eq!(r.external_id, None);
        assert_eq!(r.events[0].id, "run-1-0");
    }

    #[test]
    fn the_full_happy_path_reaches_succeeded() {
        let r = request_approval(run());
        assert_eq!(r.status, DeploymentRunStatus::AwaitingApproval);
        let r = approve(r);
        assert_eq!(r.status, DeploymentRunStatus::Queued);
        assert_eq!(
            r.approval.as_ref().map(|a| a.approved_by.as_str()),
            Some("alice")
        );
        let r = apply(r, DeploymentRunCommand::StartDeploying { at: next_at() });
        assert_eq!(r.status, DeploymentRunStatus::Deploying);
        let r = start_verifying(r);
        assert_eq!(r.status, DeploymentRunStatus::Verifying);
        let r = health_verified(r);
        assert_eq!(r.status, DeploymentRunStatus::Succeeded);
        assert!(r.ended_at.is_some());
        assert!(is_deployment_run_settled(&r));
    }

    #[test]
    fn only_health_verified_from_verifying_reaches_succeeded() {
        let r = health_verified(run());
        assert_eq!(r.status, DeploymentRunStatus::Prepared);
        let r = health_verified(to_deploying());
        assert_eq!(r.status, DeploymentRunStatus::Deploying);
    }

    #[test]
    fn health_failed_settles_as_failed_with_the_error() {
        let r = health_failed(start_verifying(to_deploying()), "HTTP 503 from /healthz");
        assert_eq!(r.status, DeploymentRunStatus::Failed);
        assert_eq!(r.ended_reason.as_deref(), Some("HTTP 503 from /healthz"));
    }

    #[test]
    fn start_deploying_refuses_without_an_approval() {
        let r = request_approval(run());
        let r = apply(r, DeploymentRunCommand::StartDeploying { at: next_at() });
        assert_eq!(r.status, DeploymentRunStatus::AwaitingApproval);
    }

    #[test]
    fn invalidate_approval_drops_it_and_returns_to_awaiting_approval() {
        let r = approve(request_approval(run()));
        assert!(r.approval.is_some());
        let r = apply(
            r,
            DeploymentRunCommand::InvalidateApproval {
                at: next_at(),
                reason: "artifact republished".to_string(),
            },
        );
        assert_eq!(r.status, DeploymentRunStatus::AwaitingApproval);
        assert!(r.approval.is_none());

        let before = run();
        let after = apply(
            before.clone(),
            DeploymentRunCommand::InvalidateApproval {
                at: next_at(),
                reason: "n/a".to_string(),
            },
        );
        assert_eq!(after, before);
    }

    #[test]
    fn replaying_an_absorbed_command_appends_nothing() {
        let r = request_approval(run());
        let count = r.events.len();
        let replayed = request_approval(r);
        assert_eq!(replayed.status, DeploymentRunStatus::AwaitingApproval);
        assert_eq!(replayed.events.len(), count);
    }

    #[test]
    fn a_settled_run_ignores_cancel() {
        let r = health_verified(start_verifying(to_deploying()));
        let after = apply(
            r.clone(),
            DeploymentRunCommand::Cancel {
                at: next_at(),
                reason: None,
            },
        );
        assert_eq!(after, r);
    }

    #[test]
    fn cancel_settles_every_in_flight_status() {
        for setup in [run(), request_approval(run()), to_deploying()] {
            let cancelled = apply(
                setup,
                DeploymentRunCommand::Cancel {
                    at: next_at(),
                    reason: Some("operator abort".to_string()),
                },
            );
            assert_eq!(cancelled.status, DeploymentRunStatus::Cancelled);
            assert!(is_deployment_run_settled(&cancelled));
            assert_eq!(cancelled.ended_reason.as_deref(), Some("operator abort"));
        }
    }

    #[test]
    fn mark_unknown_applies_only_mid_flight_and_is_idempotent() {
        let r = mark_unknown(
            to_deploying(),
            "process exited before an outcome was recorded",
        );
        assert_eq!(r.status, DeploymentRunStatus::Unknown);
        let again = mark_unknown(r.clone(), "still unresolved");
        assert_eq!(again, r);

        let prepared = mark_unknown(run(), "n/a");
        assert_eq!(prepared.status, DeploymentRunStatus::Prepared);
    }

    #[test]
    fn record_external_id_keeps_status_and_is_idempotent() {
        let r = record_external_id(to_deploying(), "pid:4242");
        assert_eq!(r.external_id.as_deref(), Some("pid:4242"));
        assert_eq!(r.status, DeploymentRunStatus::Deploying);
        let count = r.events.len();
        assert_eq!(record_external_id(r, "pid:4242").events.len(), count);

        assert_eq!(record_external_id(run(), "pid:1").external_id, None);
    }

    #[test]
    fn retry_dispatch_from_unknown_bumps_attempt_and_keeps_approval() {
        let r = to_deploying();
        let original = r.approval.clone();
        let r = retry(mark_unknown(record_external_id(r, "pid:old"), "crash"));
        assert_eq!(r.status, DeploymentRunStatus::Queued);
        assert_eq!(r.attempt, 2);
        assert_eq!(r.approval, original);
        assert_eq!(r.external_id, None);
    }

    #[test]
    fn retry_dispatch_from_failed_works_and_clears_the_outcome() {
        let r = health_failed(start_verifying(to_deploying()), "boom");
        let r = retry(r);
        assert_eq!(r.status, DeploymentRunStatus::Queued);
        assert_eq!(r.attempt, 2);
        assert_eq!(r.ended_at, None);
        assert_eq!(r.ended_reason, None);
    }

    #[test]
    fn a_cancelled_run_is_terminal_even_for_retry() {
        let r = apply(
            request_approval(run()),
            DeploymentRunCommand::Cancel {
                at: next_at(),
                reason: None,
            },
        );
        assert_eq!(retry(r.clone()), r);
    }

    #[test]
    fn rollback_from_succeeded_reaches_rolled_back() {
        let r = health_verified(start_verifying(to_deploying()));
        let r = apply(r, DeploymentRunCommand::StartRollback { at: next_at() });
        assert_eq!(r.status, DeploymentRunStatus::RollingBack);
        let r = apply(r, DeploymentRunCommand::RollbackSucceeded { at: next_at() });
        assert_eq!(r.status, DeploymentRunStatus::RolledBack);
        assert!(is_deployment_run_settled(&r));
    }

    #[test]
    fn a_failed_rollback_lands_on_failed_with_its_error() {
        let r = health_failed(start_verifying(to_deploying()), "boom");
        let r = apply(r, DeploymentRunCommand::StartRollback { at: next_at() });
        assert_eq!(r.status, DeploymentRunStatus::RollingBack);
        let r = apply(
            r,
            DeploymentRunCommand::RollbackFailed {
                at: next_at(),
                error: "rollback script exited 1".to_string(),
            },
        );
        assert_eq!(r.status, DeploymentRunStatus::Failed);
        assert_eq!(r.ended_reason.as_deref(), Some("rollback script exited 1"));
    }

    #[test]
    fn approval_is_invalidated_by_a_profile_edit_or_a_new_artifact() {
        let profile = profile();
        assert!(is_approval_valid(
            &approval(),
            &profile,
            &artifact("artifact-1", "sha256:abc")
        ));
        let edited = DeploymentProfile {
            version: 2,
            target: TargetRef::Directory {
                path: "dist2".to_string(),
            },
            ..profile.clone()
        };
        assert!(!is_approval_valid(
            &approval(),
            &edited,
            &artifact("artifact-1", "sha256:abc")
        ));
        assert!(!is_approval_valid(
            &approval(),
            &profile,
            &artifact("artifact-2", "sha256:def")
        ));
    }

    #[test]
    fn target_lock_key_identifies_the_same_destination() {
        assert_eq!(dir_key("dist"), dir_key("dist"));
        assert_ne!(dir_key("dist"), dir_key("other-dist"));
        let local = TargetRef::LocalProcess {
            executable: "node".to_string(),
            args: None,
            cwd: None,
        };
        assert_eq!(target_lock_key(&local), "local-process:node:");
    }

    #[test]
    fn lock_registry_queues_refuses_and_hands_over_in_order() {
        let mut registry = DeploymentTargetLockRegistry::new();
        let key = dir_key("dist");
        assert_eq!(
            registry.try_acquire(&key, "run-1", LockPolicy::Queue),
            LockAcquireResult::Acquired
        );
        assert_eq!(
            registry.try_acquire(&key, "run-1", LockPolicy::Queue),
            LockAcquireResult::AlreadyHeldBySelf
        );
        assert_eq!(
            registry.try_acquire(&key, "run-2", LockPolicy::Refuse),
            LockAcquireResult::Refused
        );
        assert_eq!(
            registry.try_acquire(&key, "run-2", LockPolicy::Queue),
            LockAcquireResult::Queued
        );
        assert_eq!(
            registry.try_acquire(&key, "run-3", LockPolicy::Queue),
            LockAcquireResult::Queued
        );
        assert_eq!(registry.holder_of(&key), Some("run-1"));

        assert_eq!(
            registry.release(&key, "run-2"),
            None,
            "a non-holder cannot release"
        );
        assert_eq!(registry.holder_of(&key), Some("run-1"));

        assert_eq!(registry.release(&key, "run-1").as_deref(), Some("run-2"));
        assert_eq!(registry.holder_of(&key), Some("run-2"));
        assert_eq!(registry.release(&key, "run-2").as_deref(), Some("run-3"));
        assert_eq!(registry.release(&key, "run-3"), None);
        assert_eq!(registry.holder_of(&key), None);
    }

    #[test]
    fn lock_registry_keeps_targets_independent_and_can_drop_a_queued_run() {
        let mut registry = DeploymentTargetLockRegistry::new();
        let (a, b) = (dir_key("dist-a"), dir_key("dist-b"));
        registry.try_acquire(&a, "run-1", LockPolicy::Queue);
        assert_eq!(
            registry.try_acquire(&b, "run-2", LockPolicy::Queue),
            LockAcquireResult::Acquired
        );

        registry.try_acquire(&a, "run-3", LockPolicy::Queue);
        registry.try_acquire(&a, "run-4", LockPolicy::Queue);
        registry.remove_from_queue(&a, "run-3");
        assert_eq!(registry.release(&a, "run-1").as_deref(), Some("run-4"));
    }

    #[test]
    fn linking_context_is_recorded_when_supplied_and_omitted_otherwise() {
        let r = create_deployment_run(CreateDeploymentRunInput {
            issue_key: Some("PROJ-42".to_string()),
            issue_connection_id: Some("conn-1".to_string()),
            workflow_run_id: Some("wf-run-9".to_string()),
            target_url: Some("http://localhost:4000".to_string()),
            ..input()
        });
        assert_eq!(r.issue_key.as_deref(), Some("PROJ-42"));
        assert_eq!(r.workflow_run_id.as_deref(), Some("wf-run-9"));

        let json = serde_json::to_value(run()).expect("json");
        for key in [
            "issueKey",
            "issueConnectionId",
            "workflowRunId",
            "targetUrl",
        ] {
            assert!(
                json.get(key).is_none(),
                "{key} must be omitted, not stored empty"
            );
        }
    }

    #[test]
    fn commands_and_runs_use_the_typescript_json_shape() {
        let command: DeploymentRunCommand = serde_json::from_value(serde_json::json!({
            "kind": "record-external-id", "at": AT, "externalId": "pid:1"
        }))
        .expect("command");
        assert_eq!(
            command,
            DeploymentRunCommand::RecordExternalId {
                at: AT.to_string(),
                external_id: "pid:1".to_string()
            }
        );
        let json = serde_json::to_value(to_deploying()).expect("json");
        assert_eq!(json["status"], "deploying");
        assert_eq!(json["events"][1]["kind"], "approval-requested");
        assert_eq!(json["approval"]["approvedBy"], "alice");
    }
}
