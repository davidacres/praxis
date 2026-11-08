//! Run-state persistence and conservative post-restart reconciliation
//! (`projects/runReconciliation.ts` port).
//!
//! A managed service's OS process outlives the app that started it. On the next launch we
//! only know a project had services, by pid. We cannot re-verify that a pid still belongs to
//! our service, so reconciliation answers one question conservatively: is something alive at
//! that pid? If yes, the honest label is `unknown-running`, never `ready`. If no, the record
//! is stale. Nothing is restarted automatically.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const RUN_STATE_SCHEMA_VERSION: u32 = 1;
const RUN_STATE_FILE_NAME: &str = "run-state.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRunServiceRecord {
    pub service_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// State as last observed. Only `ready` and `starting` are worth reconciling.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRunState {
    pub schema_version: u32,
    pub project_id: String,
    pub run_id: String,
    pub started_at: String,
    pub services: Vec<PersistedRunServiceRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconciledServiceState {
    UnknownRunning,
    StoppedWhileClosed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciledService {
    pub service_id: String,
    pub pid: Option<u32>,
    pub state: ReconciledServiceState,
}

fn state_file_path(storage_root: &Path, project_id: &str) -> PathBuf {
    storage_root.join(project_id).join(RUN_STATE_FILE_NAME)
}

/// Overwrites the persisted run-state record for one project.
pub async fn write_run_state(
    storage_root: &Path,
    state: &PersistedRunState,
) -> std::io::Result<()> {
    let path = state_file_path(storage_root, &state.project_id);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut text = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;
    text.push('\n');
    tokio::fs::write(path, text).await
}

/// `None` when nothing is persisted, or when the file is malformed. Neither is an error.
pub async fn read_run_state(storage_root: &Path, project_id: &str) -> Option<PersistedRunState> {
    let raw = tokio::fs::read_to_string(state_file_path(storage_root, project_id))
        .await
        .ok()?;
    serde_json::from_str(&raw).ok()
}

/// Clears a project's persisted run state. Clearing nothing is not an error.
pub async fn clear_run_state(storage_root: &Path, project_id: &str) -> std::io::Result<()> {
    match tokio::fs::remove_file(state_file_path(storage_root, project_id)).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Whether a process with this pid exists. Signal 0 checks existence without signalling.
/// `EPERM` means it exists but belongs to someone else, which still counts as alive.
#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    let Ok(raw) = i32::try_from(pid) else {
        return false;
    };
    match kill(Pid::from_raw(raw), None) {
        Ok(()) => true,
        Err(Errno::EPERM) => true,
        Err(_) => false,
    }
}

/// Without a portable liveness probe on this platform, a record cannot be proven stale. Report
/// it as running so a person looks, rather than claiming it stopped.
#[cfg(not(unix))]
fn is_pid_alive(_pid: u32) -> bool {
    true
}

/// Reconciles a persisted record against the live process table. A record with no pid
/// (never spawned before the app closed) is `StoppedWhileClosed`.
#[must_use]
pub fn reconcile_run_state(state: &PersistedRunState) -> Vec<ReconciledService> {
    state
        .services
        .iter()
        .map(|record| ReconciledService {
            service_id: record.service_id.clone(),
            pid: record.pid,
            state: match record.pid {
                Some(pid) if is_pid_alive(pid) => ReconciledServiceState::UnknownRunning,
                _ => ReconciledServiceState::StoppedWhileClosed,
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScratchDir;

    fn state(project_id: &str, services: Vec<PersistedRunServiceRecord>) -> PersistedRunState {
        PersistedRunState {
            schema_version: RUN_STATE_SCHEMA_VERSION,
            project_id: project_id.into(),
            run_id: "run-1".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            services,
        }
    }

    fn record(service_id: &str, pid: Option<u32>) -> PersistedRunServiceRecord {
        PersistedRunServiceRecord {
            service_id: service_id.into(),
            pid,
            state: "ready".into(),
            started_at: None,
        }
    }

    #[tokio::test]
    async fn reading_with_no_persisted_state_gives_none() {
        let dir = ScratchDir::new("run-state-none");
        assert!(read_run_state(dir.path(), "p").await.is_none());
    }

    #[tokio::test]
    async fn a_written_state_round_trips_unchanged() {
        let dir = ScratchDir::new("run-state-rt");
        let original = state("p", vec![record("web", Some(4242))]);
        write_run_state(dir.path(), &original)
            .await
            .expect("test setup");
        assert_eq!(read_run_state(dir.path(), "p").await, Some(original));
    }

    #[tokio::test]
    async fn a_malformed_persisted_file_is_treated_as_no_state() {
        let dir = ScratchDir::new("run-state-bad");
        tokio::fs::create_dir_all(dir.path().join("p"))
            .await
            .expect("test setup");
        tokio::fs::write(dir.path().join("p").join(RUN_STATE_FILE_NAME), "{oops")
            .await
            .expect("test setup");
        assert!(read_run_state(dir.path(), "p").await.is_none());
    }

    #[tokio::test]
    async fn two_projects_states_do_not_collide() {
        let dir = ScratchDir::new("run-state-two");
        write_run_state(dir.path(), &state("a", vec![record("web", Some(1))]))
            .await
            .expect("test setup");
        write_run_state(dir.path(), &state("b", vec![record("api", Some(2))]))
            .await
            .expect("test setup");
        assert_eq!(
            read_run_state(dir.path(), "a")
                .await
                .expect("test setup")
                .services[0]
                .service_id,
            "web"
        );
        assert_eq!(
            read_run_state(dir.path(), "b")
                .await
                .expect("test setup")
                .services[0]
                .service_id,
            "api"
        );
    }

    #[tokio::test]
    async fn clear_removes_exactly_one_project_and_is_a_no_op_when_empty() {
        let dir = ScratchDir::new("run-state-clear");
        write_run_state(dir.path(), &state("a", vec![]))
            .await
            .expect("test setup");
        write_run_state(dir.path(), &state("b", vec![]))
            .await
            .expect("test setup");
        clear_run_state(dir.path(), "a").await.expect("test setup");
        assert!(read_run_state(dir.path(), "a").await.is_none());
        assert!(read_run_state(dir.path(), "b").await.is_some());
        clear_run_state(dir.path(), "never-existed")
            .await
            .expect("test setup");
    }

    #[test]
    fn a_still_alive_pid_is_unknown_running_never_ready() {
        let me = std::process::id();
        let result = reconcile_run_state(&state("p", vec![record("web", Some(me))]));
        assert_eq!(result[0].state, ReconciledServiceState::UnknownRunning);
    }

    #[cfg(unix)]
    #[test]
    fn a_pid_that_no_longer_exists_is_stopped_while_closed() {
        // A child we spawned and reaped has a pid the OS will not reuse this quickly.
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("test setup");
        let pid = child.id();
        child.wait().expect("test setup");
        let result = reconcile_run_state(&state("p", vec![record("web", Some(pid))]));
        assert_eq!(result[0].state, ReconciledServiceState::StoppedWhileClosed);
    }

    #[test]
    fn a_record_with_no_pid_reconciles_straight_to_stopped() {
        let result = reconcile_run_state(&state("p", vec![record("web", None)]));
        assert_eq!(result[0].state, ReconciledServiceState::StoppedWhileClosed);
    }

    #[test]
    fn every_service_in_the_record_is_reconciled_independently() {
        let me = std::process::id();
        let result = reconcile_run_state(&state(
            "p",
            vec![record("web", Some(me)), record("api", None)],
        ));
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].state, ReconciledServiceState::UnknownRunning);
        assert_eq!(result[1].state, ReconciledServiceState::StoppedWhileClosed);
    }
}
