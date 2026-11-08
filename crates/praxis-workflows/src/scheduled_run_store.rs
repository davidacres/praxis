//! Durable storage for scheduled runs (`scheduledRunStore.ts` port).
//!
//! A key-value backend holds one list. `save` replaces by id. A defensive normaliser means one
//! malformed record comes back as a best-effort run instead of hiding every other schedule
//! beside it. The normaliser is also the migration point: a record written before a field
//! existed gains it here.

use std::collections::HashSet;

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value};

use crate::scheduled_run::{
    EventDraft, MAX_SCHEDULED_CONCURRENCY, SCHEDULED_RUN_SCHEMA_VERSION, ScheduledEntryOutcome,
    ScheduledEntryStatus, ScheduledPauseReason, ScheduledQueueEntry, ScheduledRun,
    ScheduledRunAttempt, ScheduledRunEvent, ScheduledRunEventKind, ScheduledRunPause,
    ScheduledRunPolicy, ScheduledRunStatus, ScheduledRunTrigger, ScheduledTicketRef,
    add_tickets_to_scheduled_run, arm_scheduled_run, reconcile_scheduled_run_on_launch,
    renumber_entries, touch,
};
use crate::scheduled_run_time::is_valid_time_zone;

/// The key the list is stored under.
pub const RUNS_KEY: &str = "praxis.scheduledRuns.v1";

/// Where the list lives. Implemented by the host over its key-value state.
pub trait ScheduledRunBackend {
    fn read(&self) -> Option<Value>;
    fn write(&mut self, value: Value) -> Result<(), String>;
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_instant(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn to_iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn stored_policy(
    raw: Option<&Map<String, Value>>,
    workflow_id: Option<String>,
) -> ScheduledRunPolicy {
    let max = raw
        .filter(|r| r.get("mode").and_then(Value::as_str) == Some("parallel"))
        .and_then(|r| r.get("maxConcurrency"))
        .and_then(Value::as_u64);
    match max {
        Some(max) if (2..=u64::from(MAX_SCHEDULED_CONCURRENCY)).contains(&max) => {
            ScheduledRunPolicy::Parallel {
                max_concurrency: u32::try_from(max).unwrap_or(MAX_SCHEDULED_CONCURRENCY),
                workflow_id,
            }
        }
        _ => ScheduledRunPolicy::Sequential { workflow_id },
    }
}

fn normalize_entry(value: &Value, fallback_sequence: u32) -> Option<ScheduledQueueEntry> {
    let raw = value.as_object()?;
    let id = text(raw.get("id"))?;
    let ticket = raw.get("ticket")?.as_object()?;
    let connection_id = text(ticket.get("connectionId"))?;
    let issue_key = text(ticket.get("issueKey"))?;
    let title = text(ticket.get("title")).unwrap_or_else(|| issue_key.clone());
    let sequence = raw
        .get("sequence")
        .and_then(Value::as_f64)
        .filter(|s| s.is_finite())
        .and_then(|s| u32::try_from(s as i64).ok())
        .unwrap_or(fallback_sequence);
    let outcome = raw
        .get("outcome")
        .filter(|v| v.is_object())
        .map(normalize_outcome);
    Some(ScheduledQueueEntry {
        id,
        sequence,
        ticket: ScheduledTicketRef {
            connection_id,
            issue_key,
            title,
        },
        with_previous: raw.get("withPrevious").and_then(Value::as_bool) == Some(true),
        outcome,
    })
}

/// Parses an outcome. A record that does not fit the shape is kept as queued, rather than
/// repaired field by field, and any repeated exhausted providers are removed.
fn normalize_outcome(value: &Value) -> ScheduledEntryOutcome {
    let mut outcome = serde_json::from_value::<ScheduledEntryOutcome>(value.clone())
        .unwrap_or_else(|_| ScheduledEntryOutcome::queued());
    let mut seen = HashSet::new();
    outcome
        .exhausted
        .retain(|p| !p.is_empty() && seen.insert(p.clone()));
    outcome
}

fn normalize_event(value: &Value) -> Option<ScheduledRunEvent> {
    serde_json::from_value::<ScheduledRunEvent>(value.clone()).ok()
}

fn normalize_attempt(value: &Value) -> Option<ScheduledRunAttempt> {
    let raw = value.as_object()?;
    let id = text(raw.get("id"))?;
    let started_at = text(raw.get("startedAt"))?;
    let trigger = if raw.get("trigger").and_then(Value::as_str) == Some("start-now") {
        ScheduledRunTrigger::StartNow
    } else {
        ScheduledRunTrigger::Schedule
    };
    Some(ScheduledRunAttempt {
        id,
        trigger,
        started_at,
        ended_at: text(raw.get("endedAt")),
    })
}

/// Parses whatever the store returns. `None` only when the record is unusable: no id, no name, or no valid start.
#[must_use]
pub fn normalize_scheduled_run(value: &Value) -> Option<ScheduledRun> {
    let raw = value.as_object()?;
    let id = text(raw.get("id"))?;
    let name = text(raw.get("name"))?;
    let start = text(raw.get("scheduledStartAt"))?;
    let start_ms = parse_instant(&start)?;

    let mut entries: Vec<(ScheduledQueueEntry, usize)> = raw
        .get("entries")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    let fallback = u32::try_from(index + 1).unwrap_or(u32::MAX);
                    normalize_entry(item, fallback).map(|entry| (entry, index))
                })
                .collect()
        })
        .unwrap_or_default();
    // Stable by stored sequence, then position, then renumbered so the sequence is contiguous.
    entries.sort_by(|(a, ia), (b, ib)| a.sequence.cmp(&b.sequence).then(ia.cmp(ib)));
    let entries: Vec<ScheduledQueueEntry> = entries.into_iter().map(|(e, _)| e).collect();

    let created_at = text(raw.get("createdAt")).unwrap_or_else(|| to_iso(start_ms));
    let status = match raw.get("status").and_then(Value::as_str) {
        Some("scheduled") => ScheduledRunStatus::Scheduled,
        Some("missed") => ScheduledRunStatus::Missed,
        Some("running") => ScheduledRunStatus::Running,
        Some("paused") => ScheduledRunStatus::Paused,
        Some("completed") => ScheduledRunStatus::Completed,
        Some("cancelled") => ScheduledRunStatus::Cancelled,
        Some("failed") => ScheduledRunStatus::Failed,
        _ => ScheduledRunStatus::Draft,
    };
    let raw_policy = raw.get("policy").and_then(Value::as_object);
    let workflow_id = text(raw_policy.and_then(|p| p.get("workflowId")));
    let pause = if status == ScheduledRunStatus::Paused {
        raw.get("pause").and_then(Value::as_object).and_then(|p| {
            let message = text(p.get("message"))?;
            let at = text(p.get("at"))?;
            let reason = serde_json::from_value::<ScheduledPauseReason>(
                p.get("reason").cloned().unwrap_or(Value::Null),
            )
            .unwrap_or(ScheduledPauseReason::User);
            Some(ScheduledRunPause {
                reason,
                entry_id: text(p.get("entryId")),
                message,
                at,
            })
        })
    } else {
        None
    };
    let timezone = text(raw.get("timezone"))
        .filter(|tz| is_valid_time_zone(tz))
        .unwrap_or_else(|| "UTC".to_string());

    Some(ScheduledRun {
        schema_version: SCHEDULED_RUN_SCHEMA_VERSION,
        id,
        name,
        project_id: text(raw.get("projectId")),
        scheduled_start_at: to_iso(start_ms),
        timezone,
        policy: stored_policy(raw_policy, workflow_id),
        delivery_branch_name: text(raw.get("deliveryBranchName")),
        entries: renumber_entries(&entries),
        status,
        attempts: raw
            .get("attempts")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(normalize_attempt).collect())
            .unwrap_or_default(),
        pause,
        created_at: created_at.clone(),
        updated_at: text(raw.get("updatedAt")).unwrap_or(created_at),
        events: raw
            .get("events")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(normalize_event).collect())
            .unwrap_or_default(),
        archived: raw.get("archived").and_then(Value::as_bool) == Some(true),
        archived_at: text(raw.get("archivedAt")),
    })
}

/// The list of scheduled runs, persisted through a backend.
pub struct ScheduledRunStore<B: ScheduledRunBackend> {
    backend: B,
}

impl<B: ScheduledRunBackend> ScheduledRunStore<B> {
    pub fn new(backend: B) -> Self {
        Self { backend }
    }

    /// Soonest start first, so the lineup and the close warning agree on what is next.
    #[must_use]
    pub fn list(&self) -> Vec<ScheduledRun> {
        let Some(Value::Array(items)) = self.backend.read() else {
            return Vec::new();
        };
        let mut runs: Vec<ScheduledRun> =
            items.iter().filter_map(normalize_scheduled_run).collect();
        runs.sort_by_key(|r| parse_instant(&r.scheduled_start_at).unwrap_or(i64::MIN));
        runs
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<ScheduledRun> {
        self.list().into_iter().find(|r| r.id == id)
    }

    fn write(&mut self, runs: &[ScheduledRun]) -> Result<(), String> {
        let value = serde_json::to_value(runs).map_err(|e| e.to_string())?;
        self.backend.write(value)
    }

    /// Inserts or replaces a run. The run is the unit of atomicity.
    pub fn save(&mut self, run: ScheduledRun) -> Result<ScheduledRun, String> {
        let mut runs = self.list();
        match runs.iter().position(|c| c.id == run.id) {
            Some(index) => runs[index] = run.clone(),
            None => runs.push(run.clone()),
        }
        self.write(&runs)?;
        Ok(run)
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        let runs = self.list();
        let next: Vec<ScheduledRun> = runs.iter().filter(|r| r.id != id).cloned().collect();
        if next.len() == runs.len() {
            return Err(format!("Scheduled run {id} was not found."));
        }
        self.write(&next)
    }

    /// Renames a run. Any status can be renamed.
    pub fn rename(&mut self, id: &str, name: &str, at: &str) -> Result<ScheduledRun, String> {
        let next = name.trim();
        if next.is_empty() {
            return Err("A scheduled run needs a name.".into());
        }
        let run = self
            .get(id)
            .ok_or_else(|| format!("Scheduled run {id} was not found."))?;
        if next == run.name {
            return Ok(run);
        }
        // Any run can be renamed to give it a descriptive label — including one that has already
        // finished, whose queue can no longer be edited.
        let mut renamed = run;
        renamed.name = next.to_string();
        let renamed = touch(
            renamed,
            at,
            Some(EventDraft {
                kind: ScheduledRunEventKind::Renamed,
                message: format!("Renamed to \"{next}\"."),
                entry_id: None,
            }),
        );
        self.save(renamed)
    }

    /// Archives or restores a run. A running schedule cannot be archived.
    pub fn set_archived(
        &mut self,
        id: &str,
        archived: bool,
        at: &str,
    ) -> Result<ScheduledRun, String> {
        let run = self
            .get(id)
            .ok_or_else(|| format!("Scheduled run {id} was not found."))?;
        if archived && run.status == ScheduledRunStatus::Running {
            return Err(format!(
                "Cannot archive scheduled run {id} while it is running."
            ));
        }
        let updated = if archived {
            ScheduledRun {
                archived: true,
                archived_at: Some(at.to_string()),
                ..run
            }
        } else {
            ScheduledRun {
                archived: false,
                archived_at: None,
                ..run
            }
        };
        self.save(updated)
    }

    /// Marks every armed run whose start passed as missed, and persists once if anything changed.
    pub fn reconcile_on_launch(&mut self, now: &str) -> Result<Vec<ScheduledRun>, String> {
        let runs = self.list();
        let mut changed = Vec::new();
        let next: Vec<ScheduledRun> = runs
            .into_iter()
            .map(|run| {
                let reconciled = reconcile_scheduled_run_on_launch(run.clone(), now);
                if reconciled != run {
                    changed.push(reconciled.clone());
                }
                reconciled
            })
            .collect();
        if !changed.is_empty() {
            self.write(&next)?;
        }
        Ok(changed)
    }
}

/// Keeps the add-ticket and arm helpers in use from this module, so the store can compose them.
pub fn add_and_arm(
    run: ScheduledRun,
    tickets: &[ScheduledTicketRef],
    at: &str,
) -> Result<ScheduledRun, String> {
    let added = add_tickets_to_scheduled_run(run, tickets, at)?;
    arm_scheduled_run(added, at)
}

/// Records one entry's outcome status. Used by the runner's store writes.
#[must_use]
pub fn entry_status_label(status: ScheduledEntryStatus) -> &'static str {
    match status {
        ScheduledEntryStatus::Queued => "queued",
        ScheduledEntryStatus::Running => "running",
        ScheduledEntryStatus::Paused => "paused",
        ScheduledEntryStatus::Done => "done",
        ScheduledEntryStatus::Failed => "failed",
        ScheduledEntryStatus::Skipped => "skipped",
    }
}

/// Appends a free-standing event to a run, stamped with `at`.
#[must_use]
pub fn record_event(
    run: ScheduledRun,
    kind: ScheduledRunEventKind,
    message: &str,
    at: &str,
) -> ScheduledRun {
    touch(
        run,
        at,
        Some(crate::scheduled_run::EventDraft {
            kind,
            message: message.to_string(),
            entry_id: None,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduled_run::{CreateScheduledRunInput, create_scheduled_run};
    use serde_json::json;

    const NOW: &str = "2026-10-20T10:00:00.000Z";

    /// An in-memory backend. Cloning shares the same state, which models an app restart.
    #[derive(Clone, Default)]
    struct Memory(std::sync::Arc<std::sync::Mutex<Option<Value>>>);

    impl ScheduledRunBackend for Memory {
        fn read(&self) -> Option<Value> {
            self.0.lock().expect("lock").clone()
        }
        fn write(&mut self, value: Value) -> Result<(), String> {
            *self.0.lock().expect("lock") = Some(value);
            Ok(())
        }
    }

    fn ticket(key: &str) -> ScheduledTicketRef {
        ScheduledTicketRef {
            connection_id: "c1".into(),
            issue_key: key.into(),
            title: format!("T {key}"),
        }
    }

    fn make(name: &str, start: &str, id: &str) -> ScheduledRun {
        create_scheduled_run(CreateScheduledRunInput {
            id: Some(id.into()),
            project_id: None,
            name: name.into(),
            scheduled_start_at: start.into(),
            timezone: "Europe/London".into(),
            tickets: ["PRX-1", "PRX-2", "PRX-3"]
                .iter()
                .map(|k| ticket(k))
                .collect(),
            with_previous: vec![],
            workflow_id: None,
            max_concurrency: None,
            at: NOW.into(),
        })
        .expect("make")
    }

    #[test]
    fn a_saved_schedule_comes_back_with_the_same_start_tickets_and_order() {
        let backend = Memory::default();
        let mut store = ScheduledRunStore::new(backend.clone());
        let mut run = make("Nightly", "2026-10-21T21:00:00Z", "run-1");
        let last = run.entries[2].id.clone();
        run = crate::scheduled_run::move_entry_in_scheduled_run(run, &last, 0, NOW).expect("move");
        run = arm_scheduled_run(run, NOW).expect("arm");
        store.save(run.clone()).expect("save");

        let reopened = ScheduledRunStore::new(backend)
            .get("run-1")
            .expect("reopened");
        assert_eq!(reopened, run);
        assert_eq!(
            reopened
                .entries
                .iter()
                .map(|e| e.ticket.issue_key.as_str())
                .collect::<Vec<_>>(),
            vec!["PRX-3", "PRX-1", "PRX-2"]
        );
        assert_eq!(reopened.scheduled_start_at, "2026-10-21T21:00:00.000Z");
        assert_eq!(reopened.timezone, "Europe/London");
    }

    #[test]
    fn save_replaces_by_id_list_is_soonest_first_and_remove_deletes() {
        let mut store = ScheduledRunStore::new(Memory::default());
        store
            .save(make("Later", "2026-10-23T10:00:00Z", "b"))
            .expect("b");
        store
            .save(make("Sooner", "2026-10-21T10:00:00Z", "a"))
            .expect("a");
        assert_eq!(
            store
                .list()
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );

        let mut renamed = store.get("a").expect("a");
        renamed.name = "Renamed".into();
        store.save(renamed).expect("save");
        assert_eq!(store.list().len(), 2);
        assert_eq!(store.get("a").map(|r| r.name), Some("Renamed".into()));

        store.remove("a").expect("remove");
        assert_eq!(
            store
                .list()
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            vec!["b"]
        );
        assert!(
            store
                .remove("a")
                .expect_err("gone")
                .contains("was not found")
        );
    }

    #[test]
    fn set_archived_archives_and_restores_and_refuses_running_runs() {
        let mut store = ScheduledRunStore::new(Memory::default());
        store
            .save(make("Test", "2026-10-21T10:00:00Z", "run-1"))
            .expect("save");

        let archived = store.set_archived("run-1", true, NOW).expect("archive");
        assert!(archived.archived);
        assert_eq!(archived.archived_at.as_deref(), Some(NOW));
        assert!(store.get("run-1").expect("stored").archived);

        let restored = store.set_archived("run-1", false, NOW).expect("restore");
        assert!(!restored.archived);
        assert!(restored.archived_at.is_none());

        let mut running = make("Running", "2026-10-21T10:00:00Z", "run-running");
        running.status = ScheduledRunStatus::Running;
        store.save(running).expect("save running");
        assert!(
            store
                .set_archived("run-running", true, NOW)
                .expect_err("refused")
                .contains("while it is running")
        );
    }

    #[test]
    fn an_unusable_record_is_dropped_without_hiding_the_others() {
        let good = make("Good", "2026-10-21T10:00:00Z", "good");
        let backend = Memory(std::sync::Arc::new(std::sync::Mutex::new(Some(json!([
            null,
            "junk",
            { "id": "x" },
            good,
            { "id": "y", "name": "y", "scheduledStartAt": "nope" }
        ])))));
        let store = ScheduledRunStore::new(backend);
        assert_eq!(
            store
                .list()
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            vec!["good"]
        );
    }

    #[test]
    fn a_legacy_record_with_bad_sequences_and_bad_entries_is_repaired() {
        let run = normalize_scheduled_run(&json!({
            "id": "old",
            "name": "Legacy",
            "scheduledStartAt": "2026-10-21T21:00:00+01:00",
            "timezone": "Not/AZone",
            "status": "weird",
            "entries": [
                { "id": "e3", "sequence": 7, "ticket": { "connectionId": "c", "issueKey": "PRX-3" } },
                { "id": "e1", "sequence": 2, "ticket": { "connectionId": "c", "issueKey": "PRX-1", "title": "One" } },
                { "id": "bad", "ticket": { "connectionId": "c" } },
                { "id": "e2", "sequence": 2, "ticket": { "connectionId": "c", "issueKey": "PRX-2" } }
            ]
        }))
        .expect("normalised");
        assert_eq!(run.schema_version, 1);
        assert_eq!(run.scheduled_start_at, "2026-10-21T20:00:00.000Z");
        assert_eq!(run.timezone, "UTC");
        assert_eq!(run.status, ScheduledRunStatus::Draft);
        assert_eq!(
            run.entries
                .iter()
                .map(|e| (e.id.as_str(), e.sequence))
                .collect::<Vec<_>>(),
            vec![("e1", 1), ("e2", 2), ("e3", 3)]
        );
        assert_eq!(run.entries[2].ticket.title, "PRX-3");
        assert!(run.attempts.is_empty());
        assert!(run.events.is_empty());
    }

    #[test]
    fn runner_fields_survive_a_round_trip_untouched() {
        let backend = Memory::default();
        let mut store = ScheduledRunStore::new(backend.clone());
        let mut run = make("Running", "2026-10-21T10:00:00Z", "r");
        run.delivery_branch_name = Some("WF-SR-R".into());
        run.status = ScheduledRunStatus::Paused;
        run.attempts = vec![ScheduledRunAttempt {
            id: "att-1".into(),
            trigger: ScheduledRunTrigger::StartNow,
            started_at: NOW.into(),
            ended_at: None,
        }];
        run.entries[0].outcome = Some(ScheduledEntryOutcome {
            status: ScheduledEntryStatus::Paused,
            session_id: Some("s1".into()),
            workflow_run_id: Some("w1".into()),
            started_at: Some(NOW.into()),
            reason: Some("Waiting at the Review gate".into()),
            ..ScheduledEntryOutcome::queued()
        });
        store.save(run.clone()).expect("save");
        assert_eq!(ScheduledRunStore::new(backend).get("r"), Some(run));
    }

    #[test]
    fn the_providers_that_ran_out_survive_a_round_trip_deduplicated() {
        let backend = Memory::default();
        let mut store = ScheduledRunStore::new(backend.clone());
        let mut run = make("Spent", "2026-10-21T10:00:00Z", "spent");
        run.status = ScheduledRunStatus::Running;
        run.entries[0].outcome = Some(ScheduledEntryOutcome {
            status: ScheduledEntryStatus::Failed,
            retries: Some(1),
            exhausted: vec!["claude".into(), "claude".into(), "codex".into()],
            ..ScheduledEntryOutcome::queued()
        });
        store.save(run).expect("save");
        let stored = ScheduledRunStore::new(backend)
            .get("spent")
            .expect("stored");
        let outcome = stored.entries[0].outcome.clone().expect("outcome");
        assert_eq!(
            outcome.exhausted,
            vec!["claude".to_string(), "codex".to_string()]
        );
        assert_eq!(outcome.retries, Some(1));
    }

    #[test]
    fn reconcile_on_launch_marks_only_overdue_armed_runs_missed_and_persists_once() {
        let mut store = ScheduledRunStore::new(Memory::default());
        store
            .save(
                arm_scheduled_run(make("Overdue", "2026-10-21T10:00:00Z", "overdue"), NOW)
                    .expect("arm"),
            )
            .expect("save");
        store
            .save(
                arm_scheduled_run(make("Future", "2026-10-30T10:00:00Z", "future"), NOW)
                    .expect("arm"),
            )
            .expect("save");
        store
            .save(make("Draft", "2026-10-21T10:00:00Z", "draft"))
            .expect("save");

        let changed = store
            .reconcile_on_launch("2026-10-25T00:00:00Z")
            .expect("reconcile");
        assert_eq!(
            changed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["overdue"]
        );
        assert_eq!(
            store.get("overdue").map(|r| r.status),
            Some(ScheduledRunStatus::Missed)
        );
        assert_eq!(
            store.get("future").map(|r| r.status),
            Some(ScheduledRunStatus::Scheduled)
        );
        assert_eq!(
            store.get("draft").map(|r| r.status),
            Some(ScheduledRunStatus::Draft)
        );
        assert!(
            store
                .reconcile_on_launch("2026-10-25T00:00:00Z")
                .expect("again")
                .is_empty()
        );
    }

    #[test]
    fn the_project_id_survives_a_round_trip_and_an_unset_one_stays_unset() {
        let mut store = ScheduledRunStore::new(Memory::default());
        let mut mine = make("Mine", "2026-10-21T10:00:00Z", "mine");
        mine.project_id = Some("p1".into());
        store.save(mine).expect("mine");
        store
            .save(make("Loose", "2026-10-22T10:00:00Z", "loose"))
            .expect("loose");
        assert_eq!(
            store.get("mine").and_then(|r| r.project_id),
            Some("p1".into())
        );
        assert_eq!(store.get("loose").and_then(|r| r.project_id), None);
    }

    #[test]
    fn rename_updates_the_name_and_records_an_event_on_any_status() {
        let mut store = ScheduledRunStore::new(Memory::default());
        let mut run = make("Old Name", "2026-10-21T10:00:00Z", "to-rename");
        run.status = ScheduledRunStatus::Completed;
        store.save(run).expect("save");

        let renamed = store
            .rename("to-rename", "  New Descriptive Name  ", NOW)
            .expect("rename");
        assert_eq!(renamed.name, "New Descriptive Name");
        assert_eq!(
            store.get("to-rename").map(|r| r.name),
            Some("New Descriptive Name".into())
        );
        assert!(
            renamed
                .events
                .iter()
                .any(|e| e.kind == ScheduledRunEventKind::Renamed
                    && e.message.contains("New Descriptive Name"))
        );
        assert!(
            store
                .rename("to-rename", "   ", NOW)
                .expect_err("blank")
                .contains("needs a name")
        );
    }

    #[test]
    fn a_blank_name_and_an_unknown_run_are_refused() {
        let mut store = ScheduledRunStore::new(Memory::default());
        store
            .save(make("Old Name", "2026-10-21T10:00:00Z", "to-rename"))
            .expect("save");
        assert!(
            store
                .rename("to-rename", "   ", NOW)
                .expect_err("blank")
                .contains("needs a name")
        );
        assert!(
            store
                .rename("nope", "New Name", NOW)
                .expect_err("missing")
                .contains("was not found")
        );
    }
}
