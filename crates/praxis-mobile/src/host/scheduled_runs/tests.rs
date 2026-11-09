use super::*;

#[test]
fn status_serialization_accepts_only_string_values() {
    assert_eq!(word("queued"), "queued");
    assert_eq!(word(42), "");
}

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
struct Store(Mutex<Vec<ScheduledRun>>, AtomicBool);
#[async_trait]
impl MobileScheduleStore for Store {
    fn list(&self) -> Vec<ScheduledRun> {
        self.0.lock().expect("store").clone()
    }
    fn get(&self, id: &str) -> Option<ScheduledRun> {
        self.list().into_iter().find(|r| r.id == id)
    }
    async fn save(&self, run: ScheduledRun) -> Result<(), String> {
        if self.1.load(Ordering::SeqCst) {
            return Err("disk full".into());
        }
        let mut runs = self.0.lock().expect("store");
        runs.retain(|r| r.id != run.id);
        runs.push(run);
        Ok(())
    }
}

struct RecordingDeps {
    store: Arc<Store>,
    events: Arc<Mutex<Vec<String>>>,
    ambiguous: bool,
    workflow_error: bool,
    wake_error: bool,
}

#[async_trait]
impl MobileScheduleDeps for RecordingDeps {
    fn store(&self) -> Arc<dyn MobileScheduleStore> {
        self.store.clone()
    }
    async fn tickets(&self, _: &str) -> Result<Vec<ScheduledTicketRef>, String> {
        let ticket = ScheduledTicketRef {
            connection_id: "private-connection".into(),
            issue_key: "A-1".into(),
            title: "First".into(),
        };
        Ok(if self.ambiguous {
            vec![ticket.clone(), ticket]
        } else {
            vec![ticket]
        })
    }
    fn changed(&self, project: &str) {
        assert!(!self.store.list().is_empty(), "persist before notifying");
        self.events
            .lock()
            .expect("events")
            .push(format!("changed:{project}"));
    }
    async fn default_workflow(&self, _: &str) -> Result<Option<String>, String> {
        if self.workflow_error {
            return Err("workflow lookup failed".into());
        }
        Ok(Some("ticket-flow".into()))
    }
    async fn start_now(&self) -> Result<(), String> {
        assert!(
            self.store
                .list()
                .iter()
                .any(|run| run.status
                    == praxis_workflows::scheduled_run::ScheduledRunStatus::Scheduled),
            "persist before waking runner"
        );
        self.events.lock().expect("events").push("start-now".into());
        if self.wake_error {
            return Err("runner wake failed".into());
        }
        Ok(())
    }
    fn now(&self) -> String {
        "2026-10-24T00:00:00.000Z".into()
    }
}

fn input() -> MobileScheduleInput {
    MobileScheduleInput {
        name: "Tonight".into(),
        date: "2026-10-25".into(),
        time: "20:30".into(),
        timezone: "Europe/London".into(),
        issue_keys: vec!["A-1".into()],
    }
}

type ScheduleFixture = (
    Arc<dyn MobileSchedules>,
    Arc<Store>,
    Arc<Mutex<Vec<String>>>,
);

fn recorded(ambiguous: bool) -> ScheduleFixture {
    let store = Arc::new(Store::default());
    let events = Arc::new(Mutex::new(vec![]));
    let schedules = create_mobile_schedules(RecordingDeps {
        store: store.clone(),
        events: events.clone(),
        ambiguous,
        workflow_error: false,
        wake_error: false,
    });
    (schedules, store, events)
}

#[tokio::test]
async fn workflow_and_runner_errors_propagate_at_the_same_persistence_boundary_as_typescript() {
    let store = Arc::new(Store::default());
    let events = Arc::new(Mutex::new(vec![]));
    let schedules = create_mobile_schedules(RecordingDeps {
        store: store.clone(),
        events: events.clone(),
        ambiguous: false,
        workflow_error: true,
        wake_error: false,
    });
    assert_eq!(
        schedules
            .save("A", input())
            .await
            .expect_err("workflow failed"),
        "workflow lookup failed"
    );
    assert!(store.list().is_empty());
    assert!(events.lock().expect("events").is_empty());
    let schedules = create_mobile_schedules(RecordingDeps {
        store: store.clone(),
        events: events.clone(),
        ambiguous: false,
        workflow_error: false,
        wake_error: true,
    });
    let saved = schedules.save("A", input()).await.expect("save");
    let mut run = store.get(&saved.id).expect("run");
    run.status = praxis_workflows::scheduled_run::ScheduledRunStatus::Missed;
    store.save(run).await.expect("missed");
    assert_eq!(
        schedules
            .resolve_missed("A", &saved.id, MissedResolution::StartNow)
            .await
            .expect_err("wake failed"),
        "runner wake failed"
    );
    assert_eq!(
        store.get(&saved.id).expect("persisted").status,
        praxis_workflows::scheduled_run::ScheduledRunStatus::Scheduled
    );
    assert_eq!(
        *events.lock().expect("events"),
        ["changed:A", "changed:A", "start-now"]
    );
}

#[tokio::test]
async fn preserves_default_workflow_and_wakes_only_after_persisting_a_missed_run() {
    use praxis_workflows::scheduled_run::ScheduledRunStatus;
    let (schedules, store, events) = recorded(false);
    let saved = schedules.save("A", input()).await.expect("save");
    let mut run = store.get(&saved.id).expect("stored");
    assert_eq!(
        run.policy.workflow_id().map(String::as_str),
        Some("ticket-flow")
    );
    run.status = ScheduledRunStatus::Missed;
    store.save(run).await.expect("missed");
    assert!(
        schedules
            .resolve_missed("B", &saved.id, MissedResolution::StartNow)
            .await
            .is_err()
    );
    let started = schedules
        .resolve_missed("A", &saved.id, MissedResolution::StartNow)
        .await
        .expect("start now");
    assert_eq!(started.status, "scheduled");
    assert_eq!(started.scheduled_start_at, "2026-10-24T00:00:00.000Z");
    assert_eq!(
        *events.lock().expect("events"),
        ["changed:A", "changed:A", "start-now"]
    );
    assert!(
        schedules
            .resolve_missed("A", &saved.id, MissedResolution::StartNow)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn skip_does_not_wake_and_empty_schedules_cannot_be_armed() {
    use praxis_workflows::scheduled_run::ScheduledRunStatus;
    let (schedules, store, events) = recorded(false);
    let mut form = input();
    form.issue_keys.clear();
    let empty = schedules.save("A", form).await.expect("empty draft");
    assert!(schedules.set_armed("A", &empty.id, true).await.is_err());
    let mut run = store.get(&empty.id).expect("stored");
    run.status = ScheduledRunStatus::Missed;
    store.save(run).await.expect("missed");
    assert_eq!(
        schedules
            .resolve_missed("A", &empty.id, MissedResolution::Skip)
            .await
            .expect("skip")
            .status,
        "cancelled"
    );
    assert_eq!(*events.lock().expect("events"), ["changed:A", "changed:A"]);
}

#[tokio::test]
async fn ambiguous_tickets_and_failed_saves_never_notify_or_wake() {
    let (schedules, store, events) = recorded(true);
    assert!(
        schedules
            .save("A", input())
            .await
            .expect_err("ambiguous")
            .contains("ambiguous")
    );
    assert!(store.list().is_empty());
    assert!(events.lock().expect("events").is_empty());
    let (schedules, store, events) = recorded(false);
    let saved = schedules.save("A", input()).await.expect("save");
    let mut run = store.get(&saved.id).expect("stored");
    run.status = praxis_workflows::scheduled_run::ScheduledRunStatus::Missed;
    store.save(run).await.expect("missed");
    events.lock().expect("events").clear();
    store.1.store(true, Ordering::SeqCst);
    assert_eq!(
        schedules
            .resolve_missed("A", &saved.id, MissedResolution::StartNow)
            .await
            .expect_err("save failed"),
        "disk full"
    );
    assert_eq!(
        schedules.save("A", input()).await.expect_err("save failed"),
        "disk full"
    );
    assert!(events.lock().expect("events").is_empty());
    assert_eq!(
        store.get(&saved.id).expect("unchanged").status,
        praxis_workflows::scheduled_run::ScheduledRunStatus::Missed
    );
}
struct Deps(Arc<Store>);
#[async_trait]
impl MobileScheduleDeps for Deps {
    fn store(&self) -> Arc<dyn MobileScheduleStore> {
        self.0.clone()
    }
    async fn tickets(&self, _: &str) -> Result<Vec<ScheduledTicketRef>, String> {
        Ok(["A-1", "A-2"]
            .into_iter()
            .map(|key| ScheduledTicketRef {
                connection_id: "project:A".into(),
                issue_key: key.into(),
                title: key.into(),
            })
            .collect())
    }
    fn changed(&self, _: &str) {}
    fn now(&self) -> String {
        "2026-10-24T00:00:00.000Z".into()
    }
}
#[tokio::test]
async fn schedules_keep_ticket_order_and_enforce_project_scope() {
    let schedules = create_mobile_schedules(Deps(Arc::new(Store::default())));
    let input = MobileScheduleInput {
        name: "Tonight".into(),
        date: "2026-10-25".into(),
        time: "20:30".into(),
        timezone: "Europe/London".into(),
        issue_keys: vec!["A-2".into(), "A-1".into()],
    };
    let saved = schedules.save("A", input.clone()).await.expect("save");
    assert_eq!(
        saved
            .entries
            .iter()
            .map(|e| e.issue_key.as_str())
            .collect::<Vec<_>>(),
        ["A-2", "A-1"]
    );
    assert!(
        !serde_json::to_string(&saved)
            .expect("serialized projection")
            .contains("connectionId")
    );
    assert!(schedules.list("B").await.expect("list").is_empty());
    assert!(schedules.set_armed("B", &saved.id, true).await.is_err());
    assert_eq!(
        schedules
            .set_armed("A", &saved.id, true)
            .await
            .expect("arm")
            .status,
        "scheduled"
    );
    assert_eq!(
        schedules
            .set_armed("A", &saved.id, false)
            .await
            .expect("hold")
            .status,
        "draft"
    );
    let mut invalid = input;
    invalid.issue_keys = vec!["B-1".into()];
    assert!(schedules.save("A", invalid).await.is_err());
}
