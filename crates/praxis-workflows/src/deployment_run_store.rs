//! Durable deployment run storage and crash reconciliation
//! (`projects/deploymentRunStore.ts` port).
//!
//! A key-value backend holds one list of runs. A caller saves the run after every command,
//! and in particular after `start-deploying` and before invoking the executor, so a crash
//! between "decided to dispatch" and "the executor returned" still leaves a durable record.
//!
//! On restart, [`reconcile_deployment_run`] handles a run left in `deploying`/`verifying`,
//! which never received a settling event. Reconciliation never guesses an outcome; it
//! always lands on `unknown`, with a note saying what is knowable: no external id (lost
//! acknowledgement), an external id still alive (unconfirmed but running), or one that is
//! gone (unconfirmed and stopped). A settled run, including a confirmed failure, needs no
//! reconciliation.

use serde_json::Value;

use crate::deployment_run_state::{
    DEPLOYMENT_RUN_SCHEMA_VERSION, DeploymentApproval, DeploymentRun, DeploymentRunCommand,
    DeploymentRunEvent, DeploymentRunStatus, apply_deployment_run_command,
};

/// The key the list is stored under.
pub const RUNS_KEY: &str = "praxis.deploymentRuns.v1";

/// Where the list lives. Implemented by the host over its key-value state.
pub trait DeploymentRunBackend {
    fn read(&self) -> Option<Value>;
    fn write(&mut self, value: Value) -> Result<(), String>;
}

fn text(raw: &Value, key: &str) -> Option<String> {
    raw.get(key).and_then(Value::as_str).map(str::to_string)
}

fn required_text(raw: &Value, key: &str) -> Option<String> {
    text(raw, key).filter(|value| !value.is_empty())
}

fn number(raw: &Value, key: &str) -> Option<u32> {
    raw.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

/// Defensively parses a stored record: a malformed or partially written run comes back as
/// a best-effort run rather than hiding every other run beside it. `None` only when it has
/// no run id or profile id.
#[must_use]
pub fn normalize_deployment_run(value: &Value) -> Option<DeploymentRun> {
    if !value.is_object() {
        return None;
    }
    let run_id = required_text(value, "runId")?;
    let deployment_profile_id = required_text(value, "deploymentProfileId")?;
    let events = value
        .get("events")
        .and_then(Value::as_array)
        .map(|events| {
            events
                .iter()
                .filter_map(|event| {
                    serde_json::from_value::<DeploymentRunEvent>(event.clone()).ok()
                })
                .collect()
        })
        .unwrap_or_default();

    Some(DeploymentRun {
        schema_version: number(value, "schemaVersion").unwrap_or(DEPLOYMENT_RUN_SCHEMA_VERSION),
        run_id,
        deployment_profile_id,
        profile_version: number(value, "profileVersion").unwrap_or(0),
        environment: text(value, "environment").unwrap_or_default(),
        artifact_id: text(value, "artifactId").unwrap_or_default(),
        artifact_digest: text(value, "artifactDigest").unwrap_or_default(),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .and_then(DeploymentRunStatus::parse)
            .unwrap_or(DeploymentRunStatus::Prepared),
        approval: value.get("approval").and_then(|approval| {
            serde_json::from_value::<DeploymentApproval>(approval.clone()).ok()
        }),
        attempt: number(value, "attempt")
            .filter(|attempt| *attempt >= 1)
            .unwrap_or(1),
        external_id: text(value, "externalId"),
        events,
        started_at: text(value, "startedAt").unwrap_or_default(),
        ended_at: text(value, "endedAt"),
        ended_reason: text(value, "endedReason"),
        issue_key: text(value, "issueKey"),
        issue_connection_id: text(value, "issueConnectionId"),
        workflow_run_id: text(value, "workflowRunId"),
        target_url: text(value, "targetUrl"),
    })
}

pub struct DeploymentRunStore<B: DeploymentRunBackend> {
    backend: B,
}

impl<B: DeploymentRunBackend> DeploymentRunStore<B> {
    pub fn new(backend: B) -> Self {
        Self { backend }
    }

    #[must_use]
    pub fn list(&self) -> Vec<DeploymentRun> {
        match self.backend.read() {
            Some(Value::Array(entries)) => entries
                .iter()
                .filter_map(normalize_deployment_run)
                .collect(),
            _ => Vec::new(),
        }
    }

    /// One profile's runs, newest first.
    #[must_use]
    pub fn for_profile(&self, deployment_profile_id: &str) -> Vec<DeploymentRun> {
        let mut runs: Vec<DeploymentRun> = self
            .list()
            .into_iter()
            .filter(|run| run.deployment_profile_id == deployment_profile_id)
            .collect();
        runs.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        runs
    }

    #[must_use]
    pub fn get(&self, run_id: &str) -> Option<DeploymentRun> {
        self.list().into_iter().find(|run| run.run_id == run_id)
    }

    /// Inserts or replaces by run id: the run is the unit of atomicity.
    pub fn save(&mut self, run: &DeploymentRun) -> Result<(), String> {
        let mut runs = self.list();
        match runs
            .iter()
            .position(|candidate| candidate.run_id == run.run_id)
        {
            Some(index) => runs[index] = run.clone(),
            None => runs.push(run.clone()),
        }
        self.write(&runs)
    }

    pub fn remove(&mut self, run_id: &str) -> Result<(), String> {
        let runs = self.list();
        let count = runs.len();
        let next: Vec<DeploymentRun> = runs
            .into_iter()
            .filter(|run| run.run_id != run_id)
            .collect();
        if next.len() == count {
            return Err(format!("Deployment run {run_id} was not found."));
        }
        self.write(&next)
    }

    /// Every run left mid-flight: a restart's worklist for [`reconcile_deployment_run`].
    #[must_use]
    pub fn needing_reconciliation(&self) -> Vec<DeploymentRun> {
        self.list()
            .into_iter()
            .filter(|run| {
                matches!(
                    run.status,
                    DeploymentRunStatus::Deploying | DeploymentRunStatus::Verifying
                )
            })
            .collect()
    }

    fn write(&mut self, runs: &[DeploymentRun]) -> Result<(), String> {
        let value = serde_json::to_value(runs).map_err(|error| error.to_string())?;
        self.backend.write(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationResult {
    pub run: DeploymentRun,
    /// Why reconciliation landed where it did; also the `marked-unknown` event's reason.
    pub note: String,
    /// False when the run was already settled or never crashed mid-flight.
    pub reconciled: bool,
}

/// Reconciles one run against the live state of what it dispatched. `is_alive` is a narrow
/// seam (a pid check for the direct executor), so this makes no assumption about what an
/// external id is. A liveness check that errors propagates: an error is not the same as a
/// confirmed-stopped answer.
pub fn reconcile_deployment_run(
    run: DeploymentRun,
    is_alive: impl FnOnce(&str) -> Result<bool, String>,
    at: &str,
) -> Result<ReconciliationResult, String> {
    if !matches!(
        run.status,
        DeploymentRunStatus::Deploying | DeploymentRunStatus::Verifying
    ) {
        let status = serde_json::to_value(run.status)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default();
        return Ok(ReconciliationResult {
            note: format!("Status is already \"{status}\" — nothing to reconcile."),
            run,
            reconciled: false,
        });
    }

    let note = match run.external_id.as_deref().filter(|id| !id.is_empty()) {
        None => "No external operation identity was ever recorded before the interruption — lost acknowledgement, outcome unknown.".to_string(),
        Some(external_id) if is_alive(external_id)? => format!(
            "The dispatched operation ({external_id}) is still running, but its outcome was never confirmed before the interruption."
        ),
        Some(external_id) => format!(
            "The dispatched operation ({external_id}) is no longer running, and no outcome was recorded before the interruption."
        ),
    };

    let run = apply_deployment_run_command(
        run,
        DeploymentRunCommand::MarkUnknown {
            at: at.to_string(),
            reason: note.clone(),
        },
    );
    Ok(ReconciliationResult {
        run,
        note,
        reconciled: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment_run_state::{CreateDeploymentRunInput, create_deployment_run};
    use serde_json::json;
    use std::cell::{Cell, RefCell};

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

    fn fresh(run_id: &str, profile_id: &str, at: &str) -> DeploymentRun {
        create_deployment_run(CreateDeploymentRunInput {
            run_id: run_id.to_string(),
            deployment_profile_id: profile_id.to_string(),
            profile_version: 1,
            environment: "production".to_string(),
            artifact_id: "artifact-1".to_string(),
            artifact_digest: "sha256:abc".to_string(),
            at: at.to_string(),
            ..CreateDeploymentRunInput::default()
        })
    }

    fn apply(run: DeploymentRun, command: DeploymentRunCommand) -> DeploymentRun {
        apply_deployment_run_command(run, command)
    }

    fn to_deploying(run_id: &str) -> DeploymentRun {
        let r = apply(
            fresh(run_id, "production", AT),
            DeploymentRunCommand::RequestApproval { at: next_at() },
        );
        let r = apply(
            r,
            DeploymentRunCommand::Approve {
                at: next_at(),
                by: "alice".to_string(),
            },
        );
        apply(r, DeploymentRunCommand::StartDeploying { at: next_at() })
    }

    fn with_external_id(run: DeploymentRun, id: &str) -> DeploymentRun {
        apply(
            run,
            DeploymentRunCommand::RecordExternalId {
                at: next_at(),
                external_id: id.to_string(),
            },
        )
    }

    #[test]
    fn a_saved_run_round_trips_and_save_replaces_by_id() {
        let mut store = DeploymentRunStore::new(Memory::default());
        let run = fresh("run-1", "production", AT);
        store.save(&run).expect("save");
        assert_eq!(store.get("run-1"), Some(run.clone()));

        let updated = apply(run, DeploymentRunCommand::RequestApproval { at: next_at() });
        store.save(&updated).expect("save");
        assert_eq!(store.list().len(), 1);
        assert_eq!(
            store.get("run-1").map(|r| r.status),
            Some(DeploymentRunStatus::AwaitingApproval)
        );
    }

    #[test]
    fn for_profile_returns_that_profiles_runs_newest_first() {
        let mut store = DeploymentRunStore::new(Memory::default());
        store
            .save(&fresh("run-a", "staging", "2026-09-09T00:00:00.000Z"))
            .expect("save");
        store
            .save(&fresh("run-b", "production", "2026-09-09T00:01:00.000Z"))
            .expect("save");
        store
            .save(&fresh("run-c", "production", "2026-09-09T00:02:00.000Z"))
            .expect("save");
        let ids: Vec<String> = store
            .for_profile("production")
            .into_iter()
            .map(|r| r.run_id)
            .collect();
        assert_eq!(ids, ["run-c", "run-b"]);
    }

    #[test]
    fn remove_deletes_one_run_and_fails_for_an_unknown_id() {
        let mut store = DeploymentRunStore::new(Memory::default());
        store.save(&fresh("run-a", "production", AT)).expect("save");
        store.save(&fresh("run-b", "production", AT)).expect("save");
        store.remove("run-a").expect("remove");
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.get("run-a"), None);
        let error = store.remove("run-a").expect_err("already removed");
        assert!(error.contains("was not found"));
    }

    #[test]
    fn needing_reconciliation_returns_only_mid_flight_runs() {
        let mut store = DeploymentRunStore::new(Memory::default());
        store.save(&to_deploying("run-deploying")).expect("save");
        let verifying = apply(
            to_deploying("run-verifying"),
            DeploymentRunCommand::StartVerifying { at: next_at() },
        );
        store.save(&verifying).expect("save");
        store
            .save(&fresh("run-prepared", "production", AT))
            .expect("save");
        let succeeded = apply(
            apply(
                to_deploying("run-succeeded"),
                DeploymentRunCommand::StartVerifying { at: next_at() },
            ),
            DeploymentRunCommand::HealthVerified { at: next_at() },
        );
        store.save(&succeeded).expect("save");

        let mut stuck: Vec<String> = store
            .needing_reconciliation()
            .into_iter()
            .map(|r| r.run_id)
            .collect();
        stuck.sort();
        assert_eq!(stuck, ["run-deploying", "run-verifying"]);
    }

    #[test]
    fn normalize_accepts_well_formed_runs_and_rejects_garbage() {
        let run = fresh("run-1", "production", AT);
        let value = serde_json::to_value(&run).expect("json");
        assert_eq!(normalize_deployment_run(&value), Some(run));
        assert_eq!(normalize_deployment_run(&Value::Null), None);
        assert_eq!(normalize_deployment_run(&json!("not an object")), None);
        assert_eq!(normalize_deployment_run(&json!({})), None);
        assert_eq!(normalize_deployment_run(&json!({ "runId": "x" })), None);

        let linked = create_deployment_run(CreateDeploymentRunInput {
            issue_key: Some("PROJ-42".to_string()),
            issue_connection_id: Some("conn-1".to_string()),
            workflow_run_id: Some("wf-run-9".to_string()),
            target_url: Some("http://localhost:4000".to_string()),
            ..CreateDeploymentRunInput {
                run_id: "run-1".to_string(),
                deployment_profile_id: "production".to_string(),
                at: AT.to_string(),
                ..CreateDeploymentRunInput::default()
            }
        });
        let value = serde_json::to_value(&linked).expect("json");
        assert_eq!(normalize_deployment_run(&value), Some(linked));
    }

    #[test]
    fn normalize_falls_back_to_safe_defaults() {
        let minimal = normalize_deployment_run(
            &json!({ "runId": "run-1", "deploymentProfileId": "production" }),
        )
        .expect("minimal run");
        assert_eq!(minimal.status, DeploymentRunStatus::Prepared);
        assert_eq!(minimal.attempt, 1);
        assert!(minimal.events.is_empty());
    }

    #[test]
    fn reconcile_reports_lost_acknowledgement_without_an_external_id() {
        let result = reconcile_deployment_run(to_deploying("run-1"), |_| Ok(true), &next_at())
            .expect("reconcile");
        assert!(result.reconciled);
        assert_eq!(result.run.status, DeploymentRunStatus::Unknown);
        assert!(result.note.contains("lost acknowledgement"));
    }

    #[test]
    fn reconcile_distinguishes_a_running_from_a_stopped_operation() {
        let run = with_external_id(to_deploying("run-1"), "pid:4242");
        let running = reconcile_deployment_run(run.clone(), |id| Ok(id == "pid:4242"), &next_at())
            .expect("reconcile");
        assert_eq!(running.run.status, DeploymentRunStatus::Unknown);
        assert!(running.note.contains("still running"));
        assert!(running.note.contains("pid:4242"));

        let stopped = reconcile_deployment_run(run, |_| Ok(false), &next_at()).expect("reconcile");
        assert_eq!(stopped.run.status, DeploymentRunStatus::Unknown);
        assert!(stopped.note.contains("no longer running"));
    }

    #[test]
    fn a_confirmed_failure_needs_no_reconciliation_and_never_checks_liveness() {
        let run = apply(
            apply(
                to_deploying("run-1"),
                DeploymentRunCommand::StartVerifying { at: next_at() },
            ),
            DeploymentRunCommand::HealthFailed {
                at: next_at(),
                error: "confirmed 500".to_string(),
            },
        );
        let checked = RefCell::new(Vec::new());
        let result = reconcile_deployment_run(
            run.clone(),
            |id| {
                checked.borrow_mut().push(id.to_string());
                Ok(true)
            },
            &next_at(),
        )
        .expect("reconcile");
        assert!(!result.reconciled);
        assert_eq!(result.run, run);
        assert!(checked.borrow().is_empty());
    }

    #[test]
    fn reconcile_never_redispatches() {
        let result = reconcile_deployment_run(to_deploying("run-1"), |_| Ok(false), &next_at())
            .expect("reconcile");
        assert_eq!(result.run.status, DeploymentRunStatus::Unknown);
    }

    #[test]
    fn a_failing_liveness_check_propagates() {
        let run = with_external_id(to_deploying("run-1"), "pid:bad");
        let error = reconcile_deployment_run(
            run,
            |_| Err("permission denied checking pid".to_string()),
            &next_at(),
        )
        .expect_err("an erroring check is not a stopped answer");
        assert!(error.contains("permission denied"));
    }
}
