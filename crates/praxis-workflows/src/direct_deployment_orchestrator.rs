//! The `direct-process` executor's actions (`deployments/directDeploymentOrchestrator.ts`
//! port): prepare, approve, deploy, health results and explicit rollback, composed from the
//! run reducer, its store, the target locks, the process executor and the directory target.
//!
//! A repeated click or a reconnect cannot duplicate execution, for two stacked reasons:
//!
//! - the target lock is taken under a short synchronous lock with no await, so a second
//!   call for the same run sees `already-held-by-self` and a second run for the same target
//!   is refused;
//! - `start-deploying` only applies to a `queued` run, so re-sending "deploy" for a run that
//!   is in flight or settled changes nothing, and nothing is dispatched.
//!
//! A failed health check lands the run on `failed` and stops: rollback is always a separate
//! explicit action.
//!
//! The store and lock registry are shared behind `std::sync::Mutex` and locked only for
//! each read or write, never across an await, so deploys to different targets can run
//! concurrently. Unlike the TypeScript, the target lock is released on every path, including
//! a failed save.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use praxis_core::workspaces::workspace_paths::resolve_portable_folder_path;
use serde::{Deserialize, Serialize};

use crate::deployment_profile::{
    ArtifactLocation, DeploymentProfile, PublishedArtifact, SUPPORTED_EXECUTOR_KINDS,
    SUPPORTED_TARGET_KINDS, TargetRef,
};
use crate::deployment_run_state::{
    CreateDeploymentRunInput, DeploymentRun, DeploymentRunCommand, DeploymentRunEventKind,
    DeploymentRunStatus, DeploymentTargetLockRegistry, LockAcquireResult, LockPolicy,
    apply_deployment_run_command, create_deployment_run, is_approval_valid, target_lock_key,
};
use crate::deployment_run_store::{DeploymentRunBackend, DeploymentRunStore};
use crate::direct_process_executor::{DirectProcessDeploymentInput, run_direct_process_deployment};
use crate::directory_target::{
    DirectoryDeploymentInput, apply_directory_deployment, restore_directory_backup,
    verify_directory_health,
};
use crate::publish_manifest::PublishManifest;

/// The run store as the orchestrator shares it.
pub type SharedRunStore<B> = Mutex<DeploymentRunStore<B>>;

pub(crate) fn status_name(status: DeploymentRunStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

pub(crate) fn require_run<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    run_id: &str,
) -> Result<DeploymentRun, String> {
    store
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(run_id)
        .ok_or_else(|| format!("Deployment run {run_id} was not found."))
}

pub(crate) fn save<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    run: &DeploymentRun,
) -> Result<(), String> {
    store
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .save(run)
}

fn artifact_path(artifact: &PublishedArtifact) -> &str {
    match &artifact.location {
        ArtifactLocation::LocalPath { path } => path,
    }
}

// ── Prepare ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct DeploymentLinks {
    pub issue_key: Option<String>,
    pub issue_connection_id: Option<String>,
    pub workflow_run_id: Option<String>,
    pub target_url: Option<String>,
}

/// Creates and persists a fresh run. Run-id uniqueness is the caller's responsibility.
pub fn prepare_direct_deployment<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    run_id: &str,
    profile: &DeploymentProfile,
    artifact: &PublishedArtifact,
    links: DeploymentLinks,
    now: &impl Fn() -> String,
) -> Result<DeploymentRun, String> {
    let run = create_deployment_run(CreateDeploymentRunInput {
        run_id: run_id.to_string(),
        deployment_profile_id: profile.id.clone(),
        profile_version: profile.version,
        environment: profile.environment.clone(),
        artifact_id: artifact.id.clone(),
        artifact_digest: artifact.digest.clone(),
        at: now(),
        issue_key: links.issue_key,
        issue_connection_id: links.issue_connection_id,
        workflow_run_id: links.workflow_run_id,
        target_url: links.target_url,
    });
    save(store, &run)?;
    Ok(run)
}

// ── Approve ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApproveDirectDeploymentResult {
    pub run: DeploymentRun,
    pub ok: bool,
    pub reason: Option<String>,
}

/// Requests then grants approval. Re-approving an already-queued run changes nothing and
/// reports `ok`. The approval binds to the run's own prepared profile, so passing a
/// different profile here is refused rather than rebinding it. A refused approval is not
/// saved.
pub fn approve_direct_deployment<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    run_id: &str,
    profile: &DeploymentProfile,
    artifact: &PublishedArtifact,
    actor: &str,
    now: &impl Fn() -> String,
) -> Result<ApproveDirectDeploymentResult, String> {
    let existing = require_run(store, run_id)?;
    let next = apply_deployment_run_command(
        existing,
        DeploymentRunCommand::RequestApproval { at: now() },
    );
    let next = apply_deployment_run_command(
        next,
        DeploymentRunCommand::Approve {
            at: now(),
            by: actor.to_string(),
        },
    );

    let Some(approval) = &next.approval else {
        let reason = format!(
            "Run status is \"{}\"; approval requires an awaiting-approval run.",
            status_name(next.status)
        );
        return Ok(ApproveDirectDeploymentResult {
            run: next,
            ok: false,
            reason: Some(reason),
        });
    };
    if !is_approval_valid(approval, profile, artifact) {
        return Ok(ApproveDirectDeploymentResult {
            run: next,
            ok: false,
            reason: Some(
                "Approval no longer matches the current profile version or artifact digest."
                    .to_string(),
            ),
        });
    }

    save(store, &next)?;
    Ok(ApproveDirectDeploymentResult {
        run: next,
        ok: true,
        reason: None,
    })
}

// ── Deploy ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct DirectDeploymentOptions {
    /// Resolves repo-relative target paths and a local-process `cwd`.
    pub project_folder: PathBuf,
    /// Directory target only.
    pub exclude_paths: Vec<String>,
    pub backup_dir: Option<PathBuf>,
    pub staging_dir: Option<PathBuf>,
    /// Local-process target only: typed inputs passed alongside `ARTIFACT_PATH`.
    pub process_inputs: BTreeMap<String, String>,
    pub timeout: Option<Duration>,
    /// Where the profile's health check is evaluated, for either target kind.
    pub health_check_host: Option<String>,
    pub health_check_port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunDirectDeploymentResult {
    pub dispatched: bool,
    pub run: DeploymentRun,
    pub reason: Option<String>,
}

fn not_dispatched(run: DeploymentRun, reason: String) -> RunDirectDeploymentResult {
    RunDirectDeploymentResult {
        dispatched: false,
        run,
        reason: Some(reason),
    }
}

/// Dispatches an approved, queued run to its target, then verifies health. Refuses (and
/// dispatches nothing) for an unimplemented executor or target, a locked target, a repeated
/// call for a run already dispatching, or a run that is not queued.
#[allow(clippy::too_many_arguments)]
pub async fn run_direct_deployment<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    locks: &Mutex<DeploymentTargetLockRegistry>,
    run_id: &str,
    profile: &DeploymentProfile,
    artifact: &PublishedArtifact,
    manifest: &PublishManifest,
    options: &DirectDeploymentOptions,
    now: &impl Fn() -> String,
) -> Result<RunDirectDeploymentResult, String> {
    let existing = require_run(store, run_id)?;

    let executor_kind = profile.executor.kind();
    if !SUPPORTED_EXECUTOR_KINDS.contains(&executor_kind) {
        return Ok(not_dispatched(
            existing,
            format!("Executor \"{executor_kind}\" has no implementation yet."),
        ));
    }
    let target_kind = profile.target.kind();
    if !SUPPORTED_TARGET_KINDS.contains(&target_kind) {
        return Ok(not_dispatched(
            existing,
            format!("Target \"{target_kind}\" has no implementation yet."),
        ));
    }

    let lock_key = target_lock_key(&profile.target);
    let lock = locks
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .try_acquire(&lock_key, run_id, LockPolicy::Refuse);
    match lock {
        LockAcquireResult::Refused => {
            return Ok(not_dispatched(
                existing,
                "Target is locked by another deployment run.".to_string(),
            ));
        }
        LockAcquireResult::AlreadyHeldBySelf => {
            return Ok(not_dispatched(
                existing,
                "This run is already dispatching — repeated click ignored.".to_string(),
            ));
        }
        LockAcquireResult::Acquired | LockAcquireResult::Queued => {}
    }

    let outcome =
        deploy_holding_lock(store, existing, profile, artifact, manifest, options, now).await;
    locks
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .release(&lock_key, run_id);
    outcome
}

async fn deploy_holding_lock<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    existing: DeploymentRun,
    profile: &DeploymentProfile,
    artifact: &PublishedArtifact,
    manifest: &PublishManifest,
    options: &DirectDeploymentOptions,
    now: &impl Fn() -> String,
) -> Result<RunDirectDeploymentResult, String> {
    let mut current = apply_deployment_run_command(
        existing.clone(),
        DeploymentRunCommand::StartDeploying { at: now() },
    );
    if current == existing {
        let reason = format!(
            "Run status is \"{}\", not queued; nothing to dispatch.",
            status_name(existing.status)
        );
        return Ok(not_dispatched(existing, reason));
    }
    // Persist identity before the executor is ever invoked.
    save(store, &current)?;

    let dispatch = dispatch_to_target(profile, artifact, manifest, options, &current).await;
    let (mut ok, mut detail) = match dispatch {
        Ok(outcome) => {
            if let Some(external_id) = outcome.external_id {
                current = apply_deployment_run_command(
                    current,
                    DeploymentRunCommand::RecordExternalId {
                        at: now(),
                        external_id,
                    },
                );
                save(store, &current)?;
            }
            (outcome.ok, outcome.detail)
        }
        Err(error) => (false, error),
    };

    current =
        apply_deployment_run_command(current, DeploymentRunCommand::StartVerifying { at: now() });
    save(store, &current)?;

    if ok {
        if let Some(probe) = &profile.health_check {
            let host = options.health_check_host.as_deref().unwrap_or("127.0.0.1");
            let health =
                verify_directory_health(probe, host, options.health_check_port.unwrap_or(80)).await;
            ok = health.healthy;
            detail = health.detail;
        }
    }

    current = if ok {
        apply_deployment_run_command(current, DeploymentRunCommand::HealthVerified { at: now() })
    } else {
        apply_deployment_run_command(
            current,
            DeploymentRunCommand::HealthFailed {
                at: now(),
                error: detail,
            },
        )
    };
    save(store, &current)?;

    Ok(RunDirectDeploymentResult {
        dispatched: true,
        run: current,
        reason: None,
    })
}

struct DispatchOutcome {
    ok: bool,
    detail: String,
    external_id: Option<String>,
}

fn resolve(path: &str, project_folder: &Path) -> PathBuf {
    PathBuf::from(resolve_portable_folder_path(
        path,
        &project_folder.to_string_lossy(),
    ))
}

async fn dispatch_to_target(
    profile: &DeploymentProfile,
    artifact: &PublishedArtifact,
    manifest: &PublishManifest,
    options: &DirectDeploymentOptions,
    current: &DeploymentRun,
) -> Result<DispatchOutcome, String> {
    match &profile.target {
        TargetRef::Directory { path } => {
            let (Some(backup_dir), Some(staging_dir)) = (&options.backup_dir, &options.staging_dir)
            else {
                return Ok(DispatchOutcome {
                    ok: false,
                    detail: "A directory target deploy requires backupDir and stagingDir."
                        .to_string(),
                    external_id: None,
                });
            };
            // A valid profile's path is repo-relative; an absolute one passes through.
            let applied = apply_directory_deployment(&DirectoryDeploymentInput {
                target_dir: resolve(path, &options.project_folder),
                artifact_root_dir: PathBuf::from(artifact_path(artifact)),
                manifest: manifest.clone(),
                exclude_paths: options.exclude_paths.clone(),
                backup_dir: backup_dir.clone(),
                staging_dir: staging_dir.clone(),
            })
            .await?;
            Ok(DispatchOutcome {
                ok: applied.applied,
                detail: applied.error.unwrap_or_else(|| "Applied.".to_string()),
                external_id: None,
            })
        }
        TargetRef::LocalProcess {
            executable,
            args,
            cwd,
        } => {
            let mut inputs = BTreeMap::from([(
                "ARTIFACT_PATH".to_string(),
                artifact_path(artifact).to_string(),
            )]);
            inputs.extend(options.process_inputs.clone());
            let result = run_direct_process_deployment(
                DirectProcessDeploymentInput {
                    operation_id: format!("direct-process:{}:{}", current.run_id, current.attempt),
                    executable: executable.clone(),
                    args: args.clone().unwrap_or_default(),
                    cwd: cwd.as_deref().map_or_else(
                        || options.project_folder.clone(),
                        |cwd| resolve(cwd, &options.project_folder),
                    ),
                    inputs,
                    env: BTreeMap::new(),
                    timeout: options.timeout,
                },
                None,
            )
            .await;
            let ok = result.exit_code == Some(0) && !result.timed_out && !result.cancelled;
            let detail = result.error.unwrap_or_else(|| {
                format!(
                    "Exit code {}.",
                    result
                        .exit_code
                        .map_or_else(|| "null".to_string(), |code| code.to_string())
                )
            });
            Ok(DispatchOutcome {
                ok,
                detail,
                external_id: result.pid.map(|pid| format!("pid:{pid}")),
            })
        }
        TargetRef::Iis { .. } => Ok(DispatchOutcome {
            ok: false,
            detail: "Target \"iis\" has no implementation yet.".to_string(),
            external_id: None,
        }),
    }
}

// ── Health results ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeploymentHealthResult {
    pub status: DeploymentRunStatus,
    /// Absent until the run reaches a health outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub healthy: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// A read-only summary of a run's last recorded health outcome.
#[must_use]
pub fn deployment_health_result(run: &DeploymentRun) -> DeploymentHealthResult {
    let last = run.events.iter().rev().find(|event| {
        matches!(
            event.kind,
            DeploymentRunEventKind::HealthVerified | DeploymentRunEventKind::HealthFailed
        )
    });
    DeploymentHealthResult {
        status: run.status,
        healthy: last.map(|event| event.kind == DeploymentRunEventKind::HealthVerified),
        detail: last.map(|event| event.message.clone()),
    }
}

// ── Explicit rollback ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollbackDirectDeploymentResult {
    pub rolled_back: bool,
    pub run: DeploymentRun,
    pub reason: Option<String>,
}

fn rollback_failed<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    started: DeploymentRun,
    error: String,
    now: &impl Fn() -> String,
) -> Result<RollbackDirectDeploymentResult, String> {
    let failed = apply_deployment_run_command(
        started,
        DeploymentRunCommand::RollbackFailed { at: now(), error },
    );
    save(store, &failed)?;
    Ok(RollbackDirectDeploymentResult {
        rolled_back: false,
        reason: failed.ended_reason.clone(),
        run: failed,
    })
}

/// Restores the previous version of a directory target. Any other target kind has no
/// restore mechanism, and the refusal is recorded: `rollback-started` then `rollback-failed`
/// with the reason, so the run's own log shows the attempt and why it could not proceed.
pub async fn rollback_direct_deployment<B: DeploymentRunBackend>(
    store: &SharedRunStore<B>,
    run_id: &str,
    profile: &DeploymentProfile,
    project_folder: &Path,
    backup_dir: Option<&Path>,
    exclude_paths: &[String],
    now: &impl Fn() -> String,
) -> Result<RollbackDirectDeploymentResult, String> {
    let existing = require_run(store, run_id)?;
    let started = apply_deployment_run_command(
        existing.clone(),
        DeploymentRunCommand::StartRollback { at: now() },
    );
    if started == existing {
        let reason = format!(
            "Run status is \"{}\"; rollback only applies to a succeeded or failed run.",
            status_name(existing.status)
        );
        return Ok(RollbackDirectDeploymentResult {
            rolled_back: false,
            run: existing,
            reason: Some(reason),
        });
    }
    save(store, &started)?;

    let TargetRef::Directory { path } = &profile.target else {
        let error = format!(
            "Rollback is not supported for target kind \"{}\" — only a directory target's backup/restore is implemented.",
            profile.target.kind()
        );
        return rollback_failed(store, started, error, now);
    };
    let Some(backup_dir) = backup_dir else {
        return rollback_failed(
            store,
            started,
            "No backup directory was recorded for this run; nothing to restore.".to_string(),
            now,
        );
    };

    let restore =
        restore_directory_backup(&resolve(path, project_folder), backup_dir, exclude_paths).await?;
    if !restore.restored {
        let error = restore
            .error
            .unwrap_or_else(|| "Restore failed.".to_string());
        return rollback_failed(store, started, error, now);
    }
    let next = apply_deployment_run_command(
        started,
        DeploymentRunCommand::RollbackSucceeded { at: now() },
    );
    save(store, &next)?;
    Ok(RollbackDirectDeploymentResult {
        rolled_back: true,
        run: next,
        reason: None,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::deployment_profile::{
        DeploymentRollbackKind, DeploymentRollbackPolicy, ExecutorRef, WorkflowEvidenceSourceRef,
    };
    use crate::publish_manifest::build_publish_manifest;
    use crate::run_profile::RunReadinessProbe;
    use crate::test_support::ScratchDir;
    use serde_json::Value;
    use std::cell::Cell;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

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

    fn clock() -> impl Fn() -> String {
        let tick = Cell::new(0u32);
        move || {
            tick.set(tick.get() + 1);
            let n = tick.get();
            format!("2026-09-09T00:{:02}:{:02}.000Z", n / 60, n % 60)
        }
    }

    fn profile(target: TargetRef) -> DeploymentProfile {
        DeploymentProfile {
            schema_version: 1,
            id: "profile-1".to_string(),
            version: 1,
            name: "Staging".to_string(),
            project_id: "project-1".to_string(),
            environment: "staging".to_string(),
            executor: ExecutorRef::DirectProcess,
            target,
            health_check: None,
            rollback: DeploymentRollbackPolicy {
                kind: DeploymentRollbackKind::KeepPreviousArtifact,
                retain_count: None,
            },
            credentials: None,
            created_at: "2026-09-09T00:00:00.000Z".to_string(),
            updated_at: "2026-09-09T00:00:00.000Z".to_string(),
        }
    }

    fn directory(dir: &Path) -> TargetRef {
        TargetRef::Directory {
            path: dir.to_string_lossy().into_owned(),
        }
    }

    fn sh(script: &str) -> TargetRef {
        TargetRef::LocalProcess {
            executable: "/bin/sh".to_string(),
            args: Some(vec!["-c".to_string(), script.to_string()]),
            cwd: None,
        }
    }

    struct Published {
        root: ScratchDir,
        artifact: PublishedArtifact,
        manifest: PublishManifest,
    }

    async fn published(files: &[(&str, &str)]) -> Published {
        let root = ScratchDir::new("orch-artifact");
        for (relative, content) in files {
            std::fs::write(root.path().join(relative), content).expect("write");
        }
        let manifest = build_publish_manifest(root.path(), None)
            .await
            .expect("manifest");
        let artifact = PublishedArtifact {
            id: "artifact-1".to_string(),
            deployment_profile_id: "profile-1".to_string(),
            source_commit: WorkflowEvidenceSourceRef::Unknown,
            digest: manifest.digest.clone(),
            created_at: manifest.created_at.clone(),
            location: ArtifactLocation::LocalPath {
                path: root.path().to_string_lossy().into_owned(),
            },
        };
        Published {
            root,
            artifact,
            manifest,
        }
    }

    struct Dirs {
        target: ScratchDir,
        backups: ScratchDir,
        staging: ScratchDir,
    }

    impl Dirs {
        fn new() -> Self {
            Self {
                target: ScratchDir::new("orch-target"),
                backups: ScratchDir::new("orch-backup"),
                staging: ScratchDir::new("orch-staging"),
            }
        }

        fn options(&self) -> DirectDeploymentOptions {
            DirectDeploymentOptions {
                project_folder: PathBuf::from("/unused"),
                backup_dir: Some(self.backup_dir()),
                staging_dir: Some(self.staging.path().to_path_buf()),
                ..DirectDeploymentOptions::default()
            }
        }

        fn backup_dir(&self) -> PathBuf {
            self.backups.path().join("b1")
        }

        fn read(&self, relative: &str) -> String {
            std::fs::read_to_string(self.target.path().join(relative)).expect("read")
        }
    }

    fn process_options() -> DirectDeploymentOptions {
        DirectDeploymentOptions {
            project_folder: std::env::temp_dir(),
            ..DirectDeploymentOptions::default()
        }
    }

    fn prepare_and_approve(
        store: &SharedRunStore<Memory>,
        run_id: &str,
        p: &DeploymentProfile,
        artifact: &PublishedArtifact,
        actor: &str,
        now: &impl Fn() -> String,
    ) {
        prepare_direct_deployment(store, run_id, p, artifact, DeploymentLinks::default(), now)
            .expect("prepare");
        let approved =
            approve_direct_deployment(store, run_id, p, artifact, actor, now).expect("approve");
        assert!(approved.ok, "{:?}", approved.reason);
    }

    async fn serve_ok() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 512];
                let _ = socket.read(&mut buffer).await;
                let _ = socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                    .await;
            }
        });
        port
    }

    async fn unused_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        listener.local_addr().expect("addr").port()
    }

    #[tokio::test]
    async fn prepare_persists_and_approve_queues_idempotently() {
        let (store, now) = (store(), clock());
        let p = profile(TargetRef::Directory {
            path: "/tmp/whatever".to_string(),
        });
        let art = published(&[("index.html", "v1")]).await;
        let run = prepare_direct_deployment(
            &store,
            "run-1",
            &p,
            &art.artifact,
            DeploymentLinks::default(),
            &now,
        )
        .expect("prepare");
        assert_eq!(run.status, DeploymentRunStatus::Prepared);
        assert_eq!(
            store.lock().expect("store").get("run-1").map(|r| r.status),
            Some(DeploymentRunStatus::Prepared)
        );

        let first = approve_direct_deployment(&store, "run-1", &p, &art.artifact, "dave", &now)
            .expect("approve");
        assert!(first.ok);
        assert_eq!(first.run.status, DeploymentRunStatus::Queued);
        assert_eq!(
            first.run.approval.as_ref().map(|a| a.approved_by.as_str()),
            Some("dave")
        );

        let second = approve_direct_deployment(&store, "run-1", &p, &art.artifact, "dave", &now)
            .expect("approve");
        assert!(second.ok);
        assert_eq!(
            second.run, first.run,
            "reconnect-and-reapprove changes nothing"
        );
    }

    #[tokio::test]
    async fn a_directory_target_deploys_and_passes_its_health_check() {
        let (store, locks, now, dirs) = (store(), Mutex::default(), clock(), Dirs::new());
        let art = published(&[("index.html", "<h1>v1</h1>")]).await;
        let port = serve_ok().await;
        let p = DeploymentProfile {
            health_check: Some(RunReadinessProbe::Http {
                path: "/healthz".to_string(),
                expected_status: None,
            }),
            ..profile(directory(dirs.target.path()))
        };
        prepare_and_approve(&store, "run-1", &p, &art.artifact, "dave", &now);
        let options = DirectDeploymentOptions {
            health_check_port: Some(port),
            ..dirs.options()
        };
        let result = run_direct_deployment(
            &store,
            &locks,
            "run-1",
            &p,
            &art.artifact,
            &art.manifest,
            &options,
            &now,
        )
        .await
        .expect("deploy");
        assert!(result.dispatched);
        assert_eq!(result.run.status, DeploymentRunStatus::Succeeded);
        assert_eq!(dirs.read("index.html"), "<h1>v1</h1>");
        assert_eq!(deployment_health_result(&result.run).healthy, Some(true));
    }

    #[tokio::test]
    async fn a_bad_health_check_fails_the_run_without_restoring() {
        let (store, locks, now, dirs) = (store(), Mutex::default(), clock(), Dirs::new());
        let art = published(&[("index.html", "v1")]).await;
        let port = unused_port().await;
        let p = DeploymentProfile {
            health_check: Some(RunReadinessProbe::Tcp {
                port: u32::from(port),
            }),
            ..profile(directory(dirs.target.path()))
        };
        prepare_and_approve(&store, "run-1", &p, &art.artifact, "dave", &now);
        let options = DirectDeploymentOptions {
            health_check_port: Some(port),
            ..dirs.options()
        };
        let result = run_direct_deployment(
            &store,
            &locks,
            "run-1",
            &p,
            &art.artifact,
            &art.manifest,
            &options,
            &now,
        )
        .await
        .expect("deploy");
        assert_eq!(result.run.status, DeploymentRunStatus::Failed);
        assert_eq!(dirs.read("index.html"), "v1", "no auto-restore");
        assert_eq!(deployment_health_result(&result.run).healthy, Some(false));
    }

    #[tokio::test]
    async fn a_local_process_target_gets_the_artifact_path_and_records_its_pid() {
        let (store, locks, now) = (store(), Mutex::default(), clock());
        let out = ScratchDir::new("orch-out");
        let out_file = out.path().join("result.txt");
        let art = published(&[("index.html", "v1")]).await;
        let script = format!(
            "printf %s \"$PRAXIS_DEPLOY_ARTIFACT_PATH\" > '{}'",
            out_file.display()
        );
        let p = profile(sh(&script));
        prepare_and_approve(&store, "run-1", &p, &art.artifact, "dave", &now);
        let result = run_direct_deployment(
            &store,
            &locks,
            "run-1",
            &p,
            &art.artifact,
            &art.manifest,
            &process_options(),
            &now,
        )
        .await
        .expect("deploy");
        assert_eq!(
            result.run.status,
            DeploymentRunStatus::Succeeded,
            "{:?}",
            result.run.ended_reason
        );
        assert_eq!(
            std::fs::read_to_string(&out_file).expect("read"),
            art.root.path().to_string_lossy()
        );
        let external_id = result.run.external_id.unwrap_or_default();
        assert!(
            external_id
                .strip_prefix("pid:")
                .is_some_and(|pid| pid.parse::<u32>().is_ok())
        );
    }

    #[tokio::test]
    async fn a_failing_script_fails_the_run_with_its_exit_code() {
        let (store, locks, now) = (store(), Mutex::default(), clock());
        let art = published(&[("index.html", "v1")]).await;
        let p = profile(sh("exit 3"));
        prepare_and_approve(&store, "run-1", &p, &art.artifact, "dave", &now);
        let result = run_direct_deployment(
            &store,
            &locks,
            "run-1",
            &p,
            &art.artifact,
            &art.manifest,
            &process_options(),
            &now,
        )
        .await
        .expect("deploy");
        assert_eq!(result.run.status, DeploymentRunStatus::Failed);
        assert!(
            result
                .run
                .ended_reason
                .unwrap_or_default()
                .contains("Exit code 3")
        );
    }

    #[tokio::test]
    async fn concurrent_and_repeated_deploys_dispatch_the_script_once() {
        let (store, locks, now) = (store(), Mutex::default(), clock());
        let out = ScratchDir::new("orch-counter");
        let counter = out.path().join("counter.txt");
        std::fs::write(&counter, "").expect("write");
        let art = published(&[("index.html", "v1")]).await;
        let p = profile(sh(&format!("printf x >> '{}'", counter.display())));
        prepare_and_approve(&store, "run-1", &p, &art.artifact, "dave", &now);

        let options = process_options();
        let call = || {
            run_direct_deployment(
                &store,
                &locks,
                "run-1",
                &p,
                &art.artifact,
                &art.manifest,
                &options,
                &now,
            )
        };
        let (first, second) = tokio::join!(call(), call());
        let (first, second) = (first.expect("first"), second.expect("second"));
        assert_eq!(u8::from(first.dispatched) + u8::from(second.dispatched), 1);
        assert_eq!(std::fs::read_to_string(&counter).expect("read"), "x");

        let settled = if first.dispatched { first } else { second };
        assert_eq!(settled.run.status, DeploymentRunStatus::Succeeded);
        let again = call().await.expect("reconnect");
        assert!(!again.dispatched);
        assert!(again.reason.unwrap_or_default().contains("not queued"));
        assert_eq!(again.run, settled.run);
        assert_eq!(std::fs::read_to_string(&counter).expect("read"), "x");
    }

    #[tokio::test]
    async fn unimplemented_executors_and_targets_are_refused() {
        let (store, locks, now) = (store(), Mutex::default(), clock());
        let art = published(&[("index.html", "v1")]).await;
        let options = process_options();

        let github = DeploymentProfile {
            executor: ExecutorRef::GithubActions {
                workflow_file: "deploy.yml".to_string(),
                observe_only: None,
            },
            ..profile(TargetRef::Directory {
                path: "/tmp/never-touched".to_string(),
            })
        };
        prepare_and_approve(&store, "run-1", &github, &art.artifact, "dave", &now);
        let result = run_direct_deployment(
            &store,
            &locks,
            "run-1",
            &github,
            &art.artifact,
            &art.manifest,
            &options,
            &now,
        )
        .await
        .expect("deploy");
        assert!(!result.dispatched);
        assert!(
            result
                .reason
                .unwrap_or_default()
                .contains("\"github-actions\" has no implementation")
        );

        let iis = profile(TargetRef::Iis {
            site_name: "Default Web Site".to_string(),
            app_pool_name: None,
        });
        prepare_and_approve(&store, "run-2", &iis, &art.artifact, "dave", &now);
        let result = run_direct_deployment(
            &store,
            &locks,
            "run-2",
            &iis,
            &art.artifact,
            &art.manifest,
            &options,
            &now,
        )
        .await
        .expect("deploy");
        assert!(!result.dispatched);
        assert!(
            result
                .reason
                .unwrap_or_default()
                .contains("\"iis\" has no implementation")
        );
    }

    #[tokio::test]
    async fn rollback_restores_a_directory_target() {
        let (store, locks, now, dirs) = (store(), Mutex::default(), clock(), Dirs::new());
        std::fs::write(dirs.target.path().join("index.html"), "v1").expect("write");
        let art = published(&[("index.html", "v2")]).await;
        let p = profile(directory(dirs.target.path()));
        prepare_and_approve(&store, "run-1", &p, &art.artifact, "dave", &now);
        let deployed = run_direct_deployment(
            &store,
            &locks,
            "run-1",
            &p,
            &art.artifact,
            &art.manifest,
            &dirs.options(),
            &now,
        )
        .await
        .expect("deploy");
        assert_eq!(deployed.run.status, DeploymentRunStatus::Succeeded);
        assert_eq!(dirs.read("index.html"), "v2");

        let rollback = rollback_direct_deployment(
            &store,
            "run-1",
            &p,
            Path::new("/unused"),
            Some(&dirs.backup_dir()),
            &[],
            &now,
        )
        .await
        .expect("rollback");
        assert!(rollback.rolled_back);
        assert_eq!(rollback.run.status, DeploymentRunStatus::RolledBack);
        assert_eq!(dirs.read("index.html"), "v1");
    }

    #[tokio::test]
    async fn rollback_refusals_explain_why_and_leave_evidence() {
        let (store, locks, now) = (store(), Mutex::default(), clock());
        let art = published(&[("index.html", "v1")]).await;

        let local = profile(sh("exit 0"));
        prepare_and_approve(&store, "run-1", &local, &art.artifact, "dave", &now);
        run_direct_deployment(
            &store,
            &locks,
            "run-1",
            &local,
            &art.artifact,
            &art.manifest,
            &process_options(),
            &now,
        )
        .await
        .expect("deploy");
        let rollback = rollback_direct_deployment(
            &store,
            "run-1",
            &local,
            Path::new("/unused"),
            None,
            &[],
            &now,
        )
        .await
        .expect("rollback");
        assert!(!rollback.rolled_back);
        assert!(
            rollback
                .reason
                .unwrap_or_default()
                .contains("not supported for target kind \"local-process\"")
        );
        assert_eq!(rollback.run.status, DeploymentRunStatus::Failed);
        let kinds: Vec<DeploymentRunEventKind> =
            rollback.run.events.iter().map(|e| e.kind).collect();
        assert!(kinds.contains(&DeploymentRunEventKind::RollbackStarted));
        assert!(kinds.contains(&DeploymentRunEventKind::RollbackFailed));

        let queued = profile(TargetRef::Directory {
            path: "/tmp/never-used".to_string(),
        });
        prepare_and_approve(&store, "run-2", &queued, &art.artifact, "dave", &now);
        let rollback = rollback_direct_deployment(
            &store,
            "run-2",
            &queued,
            Path::new("/unused"),
            None,
            &[],
            &now,
        )
        .await
        .expect("rollback");
        assert!(!rollback.rolled_back);
        assert!(rollback.reason.unwrap_or_default().contains("\"queued\""));

        let dirs = Dirs::new();
        let dir_profile = profile(directory(dirs.target.path()));
        prepare_and_approve(&store, "run-3", &dir_profile, &art.artifact, "dave", &now);
        run_direct_deployment(
            &store,
            &locks,
            "run-3",
            &dir_profile,
            &art.artifact,
            &art.manifest,
            &dirs.options(),
            &now,
        )
        .await
        .expect("deploy");
        let rollback = rollback_direct_deployment(
            &store,
            "run-3",
            &dir_profile,
            Path::new("/unused"),
            None,
            &[],
            &now,
        )
        .await
        .expect("rollback");
        assert!(!rollback.rolled_back);
        assert!(
            rollback
                .reason
                .unwrap_or_default()
                .contains("No backup directory")
        );
    }

    #[tokio::test]
    async fn health_result_is_empty_before_verification() {
        let (store, now) = (store(), clock());
        let art = published(&[("index.html", "v1")]).await;
        let p = profile(TargetRef::Directory {
            path: "/tmp/never-used".to_string(),
        });
        let run = prepare_direct_deployment(
            &store,
            "run-1",
            &p,
            &art.artifact,
            DeploymentLinks::default(),
            &now,
        )
        .expect("prepare");
        let health = deployment_health_result(&run);
        assert_eq!(health.status, DeploymentRunStatus::Prepared);
        assert_eq!(health.healthy, None);
    }

    #[tokio::test]
    async fn promoting_one_digest_keeps_separate_approval_and_health_evidence() {
        let (store, locks, now) = (store(), Mutex::default(), clock());
        let (test_dirs, prod_dirs) = (Dirs::new(), Dirs::new());
        let art = published(&[("index.html", "v1")]).await;
        let test_profile = DeploymentProfile {
            id: "profile-test".to_string(),
            environment: "test".to_string(),
            ..profile(directory(test_dirs.target.path()))
        };
        let prod_profile = DeploymentProfile {
            id: "profile-prod".to_string(),
            environment: "production".to_string(),
            ..profile(directory(prod_dirs.target.path()))
        };

        prepare_and_approve(
            &store,
            "run-test",
            &test_profile,
            &art.artifact,
            "alice",
            &now,
        );
        let test_run = run_direct_deployment(
            &store,
            &locks,
            "run-test",
            &test_profile,
            &art.artifact,
            &art.manifest,
            &test_dirs.options(),
            &now,
        )
        .await
        .expect("deploy test")
        .run;
        prepare_and_approve(
            &store,
            "run-prod",
            &prod_profile,
            &art.artifact,
            "bob",
            &now,
        );
        let prod_run = run_direct_deployment(
            &store,
            &locks,
            "run-prod",
            &prod_profile,
            &art.artifact,
            &art.manifest,
            &prod_dirs.options(),
            &now,
        )
        .await
        .expect("deploy prod")
        .run;

        assert_eq!(test_run.artifact_digest, prod_run.artifact_digest);
        assert_eq!(test_run.status, DeploymentRunStatus::Succeeded);
        assert_eq!(prod_run.status, DeploymentRunStatus::Succeeded);
        let (test_approval, prod_approval) = (
            test_run.approval.clone().expect("approval"),
            prod_run.approval.clone().expect("approval"),
        );
        assert_ne!(test_approval.approved_by, prod_approval.approved_by);
        assert_eq!(test_approval.environment, "test");
        assert_eq!(prod_approval.environment, "production");
        assert_ne!(
            test_approval.deployment_profile_id,
            prod_approval.deployment_profile_id
        );
        assert_ne!(test_run.events, prod_run.events);
        assert_eq!(test_dirs.read("index.html"), "v1");
        assert_eq!(prod_dirs.read("index.html"), "v1");
    }

    #[tokio::test]
    async fn approval_binds_to_the_prepared_profile_not_the_one_passed_in() {
        let (store, now) = (store(), clock());
        let art = published(&[("index.html", "v1")]).await;
        let test_profile = DeploymentProfile {
            id: "profile-test".to_string(),
            environment: "test".to_string(),
            ..profile(TargetRef::Directory {
                path: "/tmp/never-used-test".to_string(),
            })
        };
        let prod_profile = DeploymentProfile {
            id: "profile-prod".to_string(),
            environment: "production".to_string(),
            ..profile(TargetRef::Directory {
                path: "/tmp/never-used-prod".to_string(),
            })
        };
        prepare_direct_deployment(
            &store,
            "run-prod",
            &prod_profile,
            &art.artifact,
            DeploymentLinks::default(),
            &now,
        )
        .expect("prepare");

        let mistaken = approve_direct_deployment(
            &store,
            "run-prod",
            &test_profile,
            &art.artifact,
            "alice",
            &now,
        )
        .expect("approve");
        assert!(!mistaken.ok);
        assert_eq!(
            mistaken
                .run
                .approval
                .as_ref()
                .map(|a| a.deployment_profile_id.as_str()),
            Some("profile-prod")
        );
        assert!(
            mistaken
                .reason
                .unwrap_or_default()
                .contains("no longer matches")
        );

        let correct = approve_direct_deployment(
            &store,
            "run-prod",
            &prod_profile,
            &art.artifact,
            "alice",
            &now,
        )
        .expect("approve");
        assert!(correct.ok);
        assert_eq!(
            correct.run.approval.map(|a| a.environment).as_deref(),
            Some("production")
        );
    }
}
