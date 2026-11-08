//! Port of `workflowOrchestrator.test.ts`: dispatch, contention, outcomes, worktrees,
//! timeouts, recovery, cancellation, provider-limit policies, and graceful shutdown.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use praxis_workflows::orchestrator::{
    FallbackProviderChooser, StageDispatchContext, StageDispatcher, StageOutcome,
    WorkflowOrchestrator, WorkflowOrchestratorOptions, WorkflowRunPersistence,
    WorkflowWorkspaceProvider,
};
use praxis_workflows::run::{
    CreateWorkflowRunInput, DeclaredArtifact, WorkflowPauseReason, WorkflowProviderLimitPolicy,
    WorkflowRun, WorkflowRunCommand, WorkflowRunEventKind, WorkflowRunStatus, apply_command,
    create_workflow_run,
};
use praxis_workflows::types::{
    WorkflowAgentTaskNode, WorkflowCheckNode, WorkflowDefinition, WorkflowNode, WorkflowNodeOutcome,
};
use serde_json::json;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A clock that advances one minute per read, like the TS test's `now`.
fn clock() -> Arc<dyn Fn() -> String + Send + Sync> {
    let minute = Arc::new(AtomicU32::new(0));
    Arc::new(move || {
        let m = minute.fetch_add(1, Ordering::SeqCst);
        let base = chrono::DateTime::parse_from_rfc3339("2026-09-02T09:00:00Z").expect("base time");
        (base + chrono::Duration::minutes(i64::from(m)))
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    })
}

/// Lets spawned stage tasks and queued orchestrator work drain.
async fn settle_all() {
    for _ in 0..25 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

// ── Ports ────────────────────────────────────────────────────────────────

type SaveGuard = Box<dyn Fn(&WorkflowRun) -> bool + Send + Sync>;

#[derive(Default)]
struct MemoryRuns {
    runs: Mutex<HashMap<String, WorkflowRun>>,
    /// Fails a save when this returns true.
    refuse: Mutex<Option<SaveGuard>>,
}

impl MemoryRuns {
    fn run(&self) -> WorkflowRun {
        lock(&self.runs)
            .get("run-1")
            .cloned()
            .expect("run-1 is stored")
    }
    fn put(&self, run: WorkflowRun) {
        lock(&self.runs).insert(run.run_id.clone(), run);
    }
}

#[async_trait]
impl WorkflowRunPersistence for MemoryRuns {
    fn get(&self, run_id: &str) -> Option<WorkflowRun> {
        lock(&self.runs).get(run_id).cloned()
    }
    async fn save(&self, run: WorkflowRun) -> Result<WorkflowRun, String> {
        if lock(&self.refuse)
            .as_ref()
            .is_some_and(|refuse| refuse(&run))
        {
            return Err("disk unavailable".to_string());
        }
        self.put(run.clone());
        Ok(run)
    }
}

type Auto = Box<dyn Fn(&str) -> StageOutcome + Send + Sync>;
type CancelCheck = Box<dyn Fn(&str) + Send + Sync>;

/// Records every dispatch and lets a test decide when each one finishes.
#[derive(Default)]
struct FakeDispatcher {
    started: Mutex<Vec<String>>,
    cancelled: Mutex<Vec<String>>,
    worktrees: Mutex<Vec<Option<String>>>,
    pending: Mutex<HashMap<String, oneshot::Sender<StageOutcome>>>,
    tokens: Mutex<HashMap<String, CancellationToken>>,
    auto: Option<Auto>,
    /// Asserted on each cancellation (shutdown must persist interruption first).
    on_cancel: Mutex<Option<CancelCheck>>,
}

impl FakeDispatcher {
    fn auto(f: impl Fn(&str) -> StageOutcome + Send + Sync + 'static) -> Self {
        Self {
            auto: Some(Box::new(f)),
            ..Self::default()
        }
    }
    fn started(&self) -> Vec<String> {
        lock(&self.started).clone()
    }
    fn cancelled(&self) -> Vec<String> {
        lock(&self.cancelled).clone()
    }
    fn finish(&self, node_id: &str, outcome: StageOutcome) {
        let sender = lock(&self.pending).remove(node_id);
        let sender = sender.unwrap_or_else(|| panic!("{node_id} was not dispatched"));
        let _ = sender.send(outcome);
    }
    async fn begin(
        &self,
        node_id: &str,
        context: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        lock(&self.started).push(node_id.to_string());
        lock(&self.worktrees).push(context.worktree_path.clone());
        lock(&self.tokens).insert(node_id.to_string(), context.cancel.clone());
        if let Some(auto) = &self.auto {
            return Ok(auto(node_id));
        }
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(node_id.to_string(), tx);
        Ok(rx
            .await
            .unwrap_or_else(|_| StageOutcome::failure("Cancelled")))
    }
}

#[async_trait]
impl StageDispatcher for FakeDispatcher {
    async fn run_check(
        &self,
        node: &WorkflowCheckNode,
        context: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        self.begin(&node.base.id, context).await
    }
    async fn run_agent_stage(
        &self,
        node: &WorkflowAgentTaskNode,
        context: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        context
            .reporter
            .report_session(&format!("session-{}", node.base.id));
        self.begin(&node.base.id, context).await
    }
    async fn cancel_stage(&self, node_id: &str, _run: &WorkflowRun) -> Result<(), String> {
        if let Some(check) = lock(&self.on_cancel).as_ref() {
            check(node_id);
        }
        lock(&self.cancelled).push(node_id.to_string());
        if let Some(sender) = lock(&self.pending).remove(node_id) {
            let _ = sender.send(StageOutcome::failure("Cancelled"));
        }
        Ok(())
    }
}

#[derive(Default)]
struct FakeWorkspace {
    acquired: Mutex<Vec<String>>,
    released: Mutex<Vec<String>>,
    refuse_acquire: Mutex<Option<String>>,
    failing_releases: AtomicU32,
}

#[async_trait]
impl WorkflowWorkspaceProvider for FakeWorkspace {
    async fn acquire(&self, run: &WorkflowRun) -> Result<String, String> {
        lock(&self.acquired).push(run.run_id.clone());
        if let Some(reason) = lock(&self.refuse_acquire).clone() {
            return Err(reason);
        }
        Ok(format!("/tmp/worktrees/{}", run.run_id))
    }
    async fn release(&self, run: &WorkflowRun) -> Result<(), String> {
        if self.failing_releases.load(Ordering::SeqCst) > 0 {
            self.failing_releases.fetch_sub(1, Ordering::SeqCst);
            return Err("busy".to_string());
        }
        lock(&self.released).push(run.run_id.clone());
        Ok(())
    }
}

struct Chooser(Option<&'static str>, Mutex<Vec<String>>);

#[async_trait]
impl FallbackProviderChooser for Chooser {
    async fn choose(&self, _run: &WorkflowRun, node_id: &str) -> Option<String> {
        lock(&self.1).push(node_id.to_string());
        self.0.map(str::to_string)
    }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

/// implement(mutating) → (qa ∥ security) → join → approve.
fn definition() -> serde_json::Value {
    json!({
        "schemaVersion": 1, "id": "d", "name": "D", "scope": "project", "projectId": "p1", "version": 1,
        "entryNodeId": "implement", "createdAt": "2026-09-02T09:00:00Z", "updatedAt": "2026-09-02T09:00:00Z",
        "nodes": [
            { "type": "agent-task", "id": "implement", "name": "Implement", "x": 0, "y": 0, "inputs": [],
              "agent": { "agentId": "coder", "scope": "global", "toolMode": "full" },
              "instructions": "Build.", "outputs": [{ "id": "change-diff", "kind": "diff", "required": true }],
              "mutatesWorktree": true, "maxAttempts": 2 },
            { "type": "check", "id": "qa", "name": "QA", "x": 0, "y": 0, "inputs": ["change-diff"],
              "command": "npm", "args": ["test"], "successExitCodes": [0],
              "outputs": [{ "id": "qa-results", "kind": "test-results", "required": true }], "satisfiesGate": "qa" },
            { "type": "check", "id": "security", "name": "Security", "x": 0, "y": 0, "inputs": ["change-diff"],
              "command": "npm", "args": ["audit"], "successExitCodes": [0],
              "outputs": [{ "id": "sec-report", "kind": "report", "required": true }], "satisfiesGate": "security" },
            { "type": "join", "id": "gates", "name": "Gates", "x": 0, "y": 0, "inputs": [], "mode": "all" },
            { "type": "approval", "id": "approve", "name": "Approve", "x": 0, "y": 0, "inputs": [],
              "prompt": "Ship?", "requiredGates": ["qa", "security"], "allowBypass": false }
        ],
        "edges": [
            { "id": "e1", "from": "implement", "to": "qa", "on": "success", "required": true },
            { "id": "e2", "from": "implement", "to": "security", "on": "success", "required": true },
            { "id": "e3", "from": "qa", "to": "gates", "on": "success", "required": true },
            { "id": "e4", "from": "security", "to": "gates", "on": "success", "required": true },
            { "id": "e5", "from": "gates", "to": "approve", "on": "success", "required": true }
        ]
    })
}

fn parse(value: serde_json::Value) -> WorkflowDefinition {
    serde_json::from_value(value).expect("definition deserializes")
}

/// Artifacts matching a node's declared outputs, so success is not refused.
fn outputs_for(def: &WorkflowDefinition, node_id: &str) -> Vec<DeclaredArtifact> {
    def.node(node_id)
        .map(|node| {
            node.outputs()
                .iter()
                .map(|o| DeclaredArtifact {
                    contract_id: o.id.clone(),
                    kind: o.kind,
                    path: None,
                    artifact_id: None,
                    reference: None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn success_for(def: &WorkflowDefinition, node_id: &str, snapshot: Option<&str>) -> StageOutcome {
    StageOutcome {
        succeeded: true,
        artifacts: Some(outputs_for(def, node_id)),
        snapshot_ref: snapshot.map(str::to_string),
        ..StageOutcome::default()
    }
}

struct Harness {
    runs: Arc<MemoryRuns>,
    fake: Arc<FakeDispatcher>,
    workspace: Arc<FakeWorkspace>,
    orchestrator: WorkflowOrchestrator,
    def: WorkflowDefinition,
    changes: Arc<Mutex<Vec<String>>>,
}

struct Setup {
    def: serde_json::Value,
    fake: FakeDispatcher,
    with_workspace: bool,
    chooser: Option<Arc<Chooser>>,
    customize: Box<dyn FnOnce(&mut CreateWorkflowRunInput)>,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            def: definition(),
            fake: FakeDispatcher::default(),
            with_workspace: false,
            chooser: None,
            customize: Box::new(|_| {}),
        }
    }
}

fn harness(setup: Setup) -> Harness {
    let def = parse(setup.def);
    let mut input =
        CreateWorkflowRunInput::new("run-1", "p1", def.clone(), "2026-09-02T08:00:00.000Z");
    (setup.customize)(&mut input);
    let runs = Arc::new(MemoryRuns::default());
    runs.put(create_workflow_run(input));
    let fake = Arc::new(setup.fake);
    let workspace = Arc::new(FakeWorkspace::default());
    let changes = Arc::new(Mutex::new(Vec::new()));
    let listener = Arc::clone(&changes);
    let orchestrator = WorkflowOrchestrator::new(WorkflowOrchestratorOptions {
        runs: Arc::clone(&runs) as Arc<dyn WorkflowRunPersistence>,
        dispatcher: Arc::clone(&fake) as Arc<dyn StageDispatcher>,
        workspace: setup
            .with_workspace
            .then(|| Arc::clone(&workspace) as Arc<dyn WorkflowWorkspaceProvider>),
        on_run_changed: Some(Arc::new(move |run: &WorkflowRun| {
            lock(&listener).push(run.run_id.clone())
        })),
        choose_fallback_provider: setup.chooser.map(|c| c as Arc<dyn FallbackProviderChooser>),
        now: Some(clock()),
    });
    Harness {
        runs,
        fake,
        workspace,
        orchestrator,
        def,
        changes,
    }
}

fn outcome(run: &WorkflowRun, node_id: &str) -> WorkflowNodeOutcome {
    run.nodes[node_id].outcome
}

fn at() -> String {
    "2026-09-02T10:00:00.000Z".to_string()
}

// ── Dispatch ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_entry_stage_is_dispatched_and_recorded_running_before_it_starts() {
    let h = harness(Setup::default());
    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert_eq!(h.fake.started(), ["implement"]);
    assert_eq!(
        outcome(&h.runs.run(), "implement"),
        WorkflowNodeOutcome::Running
    );
}

#[tokio::test]
async fn a_deferred_merge_is_skipped_after_the_other_stages() {
    let def = json!({
        "schemaVersion": 1, "id": "d", "name": "D", "scope": "project", "projectId": "p1", "version": 1,
        "entryNodeId": "check", "createdAt": "x", "updatedAt": "x",
        "nodes": [
            { "type": "check", "id": "check", "name": "Check", "x": 0, "y": 0, "inputs": [], "command": "true", "args": [], "successExitCodes": [0], "outputs": [] },
            { "type": "merge", "id": "merge", "name": "Merge", "x": 0, "y": 0, "inputs": [] }
        ],
        "edges": [{ "id": "e", "from": "check", "to": "merge", "on": "success", "required": true }]
    });
    let h = harness(Setup {
        def,
        fake: FakeDispatcher::auto(|_| StageOutcome::success()),
        with_workspace: true,
        customize: Box::new(|input| input.defer_merge = true),
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(h.fake.started(), ["check"]);
    assert!(run.definition.node("merge").is_some());
    assert_eq!(outcome(&run, "merge"), WorkflowNodeOutcome::Skipped);
    assert_eq!(run.status, WorkflowRunStatus::Succeeded);
}

#[tokio::test]
async fn a_stage_is_never_dispatched_twice_however_often_the_loop_is_entered() {
    let h = harness(Setup::default());
    tokio::join!(
        h.orchestrator.step("run-1"),
        h.orchestrator.step("run-1"),
        h.orchestrator.step("run-1")
    );
    settle_all().await;
    assert_eq!(h.fake.started(), ["implement"]);
    assert_eq!(h.orchestrator.in_flight_stages(), ["run-1:implement"]);
}

#[tokio::test]
async fn read_only_checks_fan_out_together_once_the_writer_settles() {
    let h = harness(Setup::default());
    h.orchestrator.step("run-1").await;
    settle_all().await;
    h.fake
        .finish("implement", success_for(&h.def, "implement", Some("sha-1")));
    settle_all().await;
    assert_eq!(h.fake.started(), ["implement", "qa", "security"]);
}

#[tokio::test]
async fn two_mutating_stages_never_run_at_once() {
    let mut def = definition();
    def["nodes"].as_array_mut().expect("nodes").push(json!({
        "type": "agent-task", "id": "refactor", "name": "Refactor", "x": 0, "y": 0, "inputs": ["change-diff"],
        "agent": { "agentId": "coder", "scope": "global", "toolMode": "full" },
        "instructions": "Tidy.", "outputs": [], "mutatesWorktree": true
    }));
    def["edges"].as_array_mut().expect("edges").push(json!({ "id": "e6", "from": "implement", "to": "refactor", "on": "success", "required": false }));
    let h = harness(Setup {
        def,
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    h.fake
        .finish("implement", success_for(&h.def, "implement", Some("sha-1")));
    settle_all().await;
    assert_eq!(
        h.fake
            .started()
            .iter()
            .filter(|id| *id == "refactor")
            .count(),
        1
    );
    let run = h.runs.run();
    let writers = ["refactor", "implement"]
        .iter()
        .filter(|id| outcome(&run, id) == WorkflowNodeOutcome::Running)
        .count();
    assert_eq!(writers, 1, "only one writer is ever running");
}

// ── Outcomes ─────────────────────────────────────────────────────────────

fn all_succeed(def: &serde_json::Value) -> FakeDispatcher {
    let def = parse(def.clone());
    FakeDispatcher::auto(move |id| success_for(&def, id, (id == "implement").then_some("sha-1")))
}

#[tokio::test]
async fn a_run_of_checks_reaches_awaiting_approval_with_no_manual_advancement() {
    let h = harness(Setup {
        fake: all_succeed(&definition()),
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(h.fake.started(), ["implement", "qa", "security"]);
    assert_eq!(
        outcome(&run, "gates"),
        WorkflowNodeOutcome::Succeeded,
        "the join converged on its own"
    );
    assert_eq!(
        outcome(&run, "approve"),
        WorkflowNodeOutcome::Pending,
        "approval waits for a person"
    );
}

#[tokio::test]
async fn a_new_implementation_snapshot_requeues_prior_downstream_evidence() {
    let def = parse(definition());
    let implements = Arc::new(AtomicU32::new(0));
    let counter = Arc::clone(&implements);
    let fake_def = def.clone();
    let fake = FakeDispatcher::auto(move |id| {
        let snapshot = (id == "implement").then(|| {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                "sha-1"
            } else {
                "sha-2"
            }
        });
        success_for(&fake_def, id, snapshot)
    });
    let h = harness(Setup {
        fake,
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    // The implementer needs another attempt after editing; prior evidence is still present.
    let mut first = h.runs.run();
    first.status = WorkflowRunStatus::Running;
    first.nodes.get_mut("implement").expect("implement").outcome = WorkflowNodeOutcome::Failed;
    h.runs.put(apply_command(
        first,
        &WorkflowRunCommand::NodeRetry {
            node_id: "implement".into(),
            at: at(),
        },
    ));
    h.orchestrator.step("run-1").await;
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(
        run.nodes["implement"].snapshot_ref.as_deref(),
        Some("sha-2")
    );
    assert_eq!(outcome(&run, "qa"), WorkflowNodeOutcome::Succeeded);
    assert_eq!(outcome(&run, "security"), WorkflowNodeOutcome::Succeeded);
    assert_eq!(run.nodes["implement"].attempts.len(), 2);
    assert!(
        run.events
            .iter()
            .any(|e| e.kind == WorkflowRunEventKind::NodeReworked)
    );
}

#[tokio::test]
async fn a_failing_check_records_its_exit_code_and_stops_the_branch() {
    let h = harness(Setup::default());
    h.orchestrator.step("run-1").await;
    settle_all().await;
    h.fake
        .finish("implement", success_for(&h.def, "implement", Some("sha-1")));
    settle_all().await;
    h.fake.finish(
        "qa",
        StageOutcome {
            exit_code: Some(1),
            ..StageOutcome::failure("tests failed")
        },
    );
    h.fake
        .finish("security", success_for(&h.def, "security", None));
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(outcome(&run, "qa"), WorkflowNodeOutcome::Failed);
    assert_eq!(run.nodes["qa"].attempts[0].exit_code, Some(1));
    assert_eq!(run.status, WorkflowRunStatus::Failed);
}

struct Throwing;

#[async_trait]
impl StageDispatcher for Throwing {
    async fn run_check(
        &self,
        _: &WorkflowCheckNode,
        _: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        Err("spawn ENOENT".into())
    }
    async fn run_agent_stage(
        &self,
        _: &WorkflowAgentTaskNode,
        _: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        panic!("no host")
    }
}

#[tokio::test]
async fn a_dispatcher_that_errors_or_panics_fails_the_stage_rather_than_wedging_the_run() {
    let runs = Arc::new(MemoryRuns::default());
    runs.put(create_workflow_run(CreateWorkflowRunInput::new(
        "run-1",
        "p1",
        parse(definition()),
        "t",
    )));
    let orchestrator = WorkflowOrchestrator::new(WorkflowOrchestratorOptions {
        runs: Arc::clone(&runs) as Arc<dyn WorkflowRunPersistence>,
        dispatcher: Arc::new(Throwing),
        workspace: None,
        on_run_changed: None,
        choose_fallback_provider: None,
        now: Some(clock()),
    });
    orchestrator.step("run-1").await;
    settle_all().await;
    let run = runs.run();
    assert_eq!(outcome(&run, "implement"), WorkflowNodeOutcome::Failed);
    assert!(
        run.nodes["implement"].attempts[0]
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("no host")
    );
    assert!(
        orchestrator.in_flight_stages().is_empty(),
        "the in-flight claim is released"
    );
}

#[tokio::test]
async fn an_agent_stage_records_its_session_id_and_snapshot_ref() {
    let h = harness(Setup::default());
    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert_eq!(
        h.runs.run().nodes["implement"].attempts[0]
            .session_id
            .as_deref(),
        Some("session-implement")
    );
    h.fake.finish(
        "implement",
        success_for(&h.def, "implement", Some("sha-abc")),
    );
    settle_all().await;
    assert_eq!(
        h.runs.run().nodes["implement"].snapshot_ref.as_deref(),
        Some("sha-abc")
    );
}

// ── Worktree ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_run_worktree_is_acquired_once_and_handed_to_every_stage() {
    let h = harness(Setup {
        fake: all_succeed(&definition()),
        with_workspace: true,
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert_eq!(*lock(&h.workspace.acquired), ["run-1"]);
    let path = Some("/tmp/worktrees/run-1".to_string());
    assert_eq!(
        *lock(&h.fake.worktrees),
        [path.clone(), path.clone(), path.clone()]
    );
    assert_eq!(h.runs.run().worktree_path, path);
}

#[tokio::test]
async fn a_worktree_that_cannot_be_set_up_pauses_the_stage_and_a_retry_tries_again() {
    let h = harness(Setup {
        with_workspace: true,
        ..Setup::default()
    });
    *lock(&h.workspace.refuse_acquire) =
        Some("1 uncommitted file in this project is not in the last commit (src/a.ts).".into());
    h.orchestrator.step("run-1").await;
    settle_all().await;
    let paused = h.runs.run();
    assert_eq!(paused.status, WorkflowRunStatus::Running);
    let attempt = paused.nodes["implement"]
        .attempts
        .last()
        .expect("attempt")
        .clone();
    assert_eq!(attempt.pause, Some(WorkflowPauseReason::Environment));
    assert!(
        attempt
            .error
            .unwrap_or_default()
            .contains("Could not set up this run's working copy: 1 uncommitted file")
    );
    assert!(h.fake.started().is_empty());
    assert_eq!(paused.worktree_path, None);

    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert_eq!(
        *lock(&h.workspace.acquired),
        ["run-1"],
        "the paused stage waits for a person"
    );

    *lock(&h.workspace.refuse_acquire) = None;
    h.runs.put(apply_command(
        h.runs.run(),
        &WorkflowRunCommand::NodeRetry {
            node_id: "implement".into(),
            at: at(),
        },
    ));
    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert_eq!(h.fake.started(), ["implement"]);
    assert_eq!(
        h.runs.run().worktree_path.as_deref(),
        Some("/tmp/worktrees/run-1")
    );
}

#[tokio::test]
async fn a_settled_run_releases_its_worktree_and_clears_the_path() {
    let mut def = definition();
    def["nodes"][0]["maxAttempts"] = json!(1);
    let h = harness(Setup {
        def,
        fake: FakeDispatcher::auto(|_| StageOutcome::failure("nope")),
        with_workspace: true,
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert_eq!(h.runs.run().status, WorkflowRunStatus::Failed);
    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert_eq!(*lock(&h.workspace.released), ["run-1"]);
    assert_eq!(h.runs.run().worktree_path, None);
}

#[tokio::test]
async fn a_failed_non_scheduled_stage_inside_its_budget_waits_for_a_person() {
    let h = harness(Setup {
        fake: FakeDispatcher::auto(|_| StageOutcome::failure("flaky")),
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    h.orchestrator.step("run-1").await;
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(run.status, WorkflowRunStatus::Running);
    assert_eq!(
        run.nodes["implement"].attempts.len(),
        1,
        "retry is a user decision"
    );
    assert_eq!(h.fake.started(), ["implement"]);
}

#[tokio::test]
async fn a_scheduled_run_retries_a_failed_agent_stage_within_its_budget() {
    let def = parse(definition());
    let tries = Arc::new(AtomicU32::new(0));
    let counter = Arc::clone(&tries);
    let fake = FakeDispatcher::auto(move |id| match id {
        "implement" if counter.fetch_add(1, Ordering::SeqCst) == 0 => {
            StageOutcome::failure("The first attempt produced no change.")
        }
        "implement" => success_for(&def, id, Some("sha-recovered")),
        _ => StageOutcome {
            pause: Some(WorkflowPauseReason::Environment),
            ..StageOutcome::failure("not part of this test")
        },
    });
    let h = harness(Setup {
        fake,
        customize: Box::new(|input| input.scheduled_launch_token = Some("schedule-1".into())),
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert_eq!(h.fake.started()[..2], ["implement", "implement"]);
    let run = h.runs.run();
    assert_eq!(outcome(&run, "implement"), WorkflowNodeOutcome::Succeeded);
    assert_eq!(run.nodes["implement"].attempts.len(), 2);
}

#[tokio::test]
async fn a_run_that_dispatches_nothing_never_branches_a_worktree() {
    let h = harness(Setup {
        with_workspace: true,
        ..Setup::default()
    });
    let mut run = h.runs.run();
    run.status = WorkflowRunStatus::Cancelled;
    h.runs.put(run);
    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert!(lock(&h.workspace.acquired).is_empty());
    assert!(h.fake.started().is_empty());
}

// ── Timeouts and recovery ────────────────────────────────────────────────

#[tokio::test]
async fn a_stage_past_its_timeout_is_cancelled_and_recorded() {
    let mut def = definition();
    def["nodes"][0]["timeoutMs"] = json!(30_000);
    let h = harness(Setup {
        def,
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    // The clock advances a minute per read, so the next read is past the timeout.
    h.orchestrator.enforce_timeouts("run-1").await;
    settle_all().await;
    assert_eq!(h.fake.cancelled(), ["implement"]);
    let run = h.runs.run();
    assert_eq!(outcome(&run, "implement"), WorkflowNodeOutcome::Failed);
    assert!(
        run.events
            .iter()
            .any(|e| e.kind == WorkflowRunEventKind::NodeTimedOut)
    );
}

#[tokio::test]
async fn enforce_timeouts_is_a_no_op_for_a_settled_run() {
    let h = harness(Setup::default());
    let mut run = h.runs.run();
    run.status = WorkflowRunStatus::Cancelled;
    h.runs.put(run);
    h.orchestrator.enforce_timeouts("run-1").await;
    settle_all().await;
    assert!(h.fake.cancelled().is_empty());
}

#[tokio::test]
async fn an_interrupted_stage_is_not_redispatched_and_every_transition_notifies() {
    let h = harness(Setup::default());
    let mut run = h.runs.run();
    run = apply_command(
        run,
        &WorkflowRunCommand::NodeStarted {
            node_id: "implement".into(),
            at: at(),
            session_id: None,
        },
    );
    run = apply_command(
        run,
        &WorkflowRunCommand::NodeInterrupted {
            node_id: "implement".into(),
            at: at(),
        },
    );
    h.runs.put(run);
    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert!(
        h.fake.started().is_empty(),
        "a failed stage is not silently restarted"
    );
    assert_eq!(h.runs.run().nodes["implement"].attempts.len(), 1);

    let h = harness(Setup {
        fake: all_succeed(&definition()),
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    let changes = lock(&h.changes).clone();
    assert!(
        changes.len() >= 4,
        "expected several notifications, got {}",
        changes.len()
    );
    assert!(changes.iter().all(|id| id == "run-1"));
}

// ── Cancellation and cleanup ─────────────────────────────────────────────

#[tokio::test]
async fn cancellation_waits_for_execution_to_exit_before_recording_and_cleanup() {
    let h = harness(Setup {
        with_workspace: true,
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    let orchestrator = h.orchestrator.clone();
    let cancelling =
        tokio::spawn(async move { orchestrator.cancel("run-1", Some("Stop now")).await });
    settle_all().await;
    assert!(
        lock(&h.fake.tokens)["implement"].is_cancelled(),
        "the stage was told to stop"
    );
    // The fake's cancel_stage resolved the stage; cancellation completes after it exits.
    cancelling
        .await
        .expect("cancel task")
        .expect("cancel succeeds");
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(run.status, WorkflowRunStatus::Cancelled);
    assert_eq!(run.ended_reason.as_deref(), Some("Stop now"));
    assert_eq!(*lock(&h.workspace.released), ["run-1"]);
    assert!(h.orchestrator.in_flight_stages().is_empty());
}

#[tokio::test]
async fn cancelling_a_check_fan_out_stops_every_child_and_dispatches_no_successor() {
    let h = harness(Setup::default());
    h.orchestrator.step("run-1").await;
    settle_all().await;
    h.fake
        .finish("implement", success_for(&h.def, "implement", Some("sha")));
    settle_all().await;
    h.orchestrator.cancel("run-1", None).await.expect("cancel");
    settle_all().await;
    let mut cancelled = h.fake.cancelled();
    cancelled.sort();
    assert_eq!(cancelled, ["qa", "security"]);
    assert_eq!(h.fake.started(), ["implement", "qa", "security"]);
    assert_eq!(h.runs.run().status, WorkflowRunStatus::Cancelled);
}

#[tokio::test]
async fn failed_cleanup_retains_the_worktree_and_a_later_step_retries() {
    let h = harness(Setup {
        with_workspace: true,
        ..Setup::default()
    });
    let mut run = h.runs.run();
    run.status = WorkflowRunStatus::Cancelled;
    run.worktree_path = Some("/tmp/retained".into());
    h.runs.put(run);
    h.workspace.failing_releases.store(1, Ordering::SeqCst);
    h.orchestrator.step("run-1").await;
    assert_eq!(h.runs.run().worktree_path.as_deref(), Some("/tmp/retained"));
    h.orchestrator.step("run-1").await;
    assert_eq!(h.runs.run().worktree_path, None);
}

#[tokio::test]
async fn metadata_updates_merge_after_queued_cleanup_without_restoring_a_stale_worktree() {
    let h = harness(Setup {
        with_workspace: true,
        ..Setup::default()
    });
    let mut run = h.runs.run();
    run.status = WorkflowRunStatus::Cancelled;
    run.worktree_path = Some("/tmp/old".into());
    h.runs.put(run);
    let (_, updated) = tokio::join!(
        h.orchestrator.step("run-1"),
        h.orchestrator.update_run("run-1", |mut current| {
            current.issue_write_back_at = Some("sent".into());
            current
        })
    );
    updated.expect("update");
    let run = h.runs.run();
    assert_eq!(run.worktree_path, None);
    assert_eq!(run.issue_write_back_at.as_deref(), Some("sent"));
}

// ── A run that ends, and a run that only pauses ──────────────────────────

async fn with_checks_running(setup: Setup) -> Harness {
    let h = harness(setup);
    h.orchestrator.step("run-1").await;
    settle_all().await;
    h.fake
        .finish("implement", success_for(&h.def, "implement", Some("sha-1")));
    settle_all().await;
    assert_eq!(h.fake.started(), ["implement", "qa", "security"]);
    h
}

#[tokio::test]
async fn a_required_failure_ends_the_run_and_stops_running_siblings() {
    let h = with_checks_running(Setup::default()).await;
    h.fake.finish(
        "security",
        StageOutcome {
            exit_code: Some(1),
            ..StageOutcome::failure("npm exited 1: found 2 high vulnerabilities")
        },
    );
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(run.status, WorkflowRunStatus::Failed);
    assert!(h.fake.cancelled().contains(&"qa".to_string()));
    assert_eq!(outcome(&run, "qa"), WorkflowNodeOutcome::Cancelled);
    let last = run.nodes["qa"].attempts.last().expect("attempt");
    assert_eq!(last.outcome, WorkflowNodeOutcome::Cancelled);
    assert!(
        last.error
            .as_deref()
            .unwrap_or_default()
            .contains("the run ended")
    );
    assert!(
        run.nodes
            .values()
            .all(|s| s.outcome != WorkflowNodeOutcome::Running)
    );
}

#[tokio::test]
async fn an_unexpectedly_aborted_agent_stage_retries_automatically() {
    let h = harness(Setup {
        customize: Box::new(|input| input.scheduled_launch_token = Some("schedule-1".into())),
        ..Setup::default()
    });
    h.orchestrator.step("run-1").await;
    settle_all().await;
    h.fake.finish(
        "implement",
        StageOutcome {
            retryable: true,
            ..StageOutcome::failure("The stage session was aborted.")
        },
    );
    settle_all().await;
    assert_eq!(h.fake.started(), ["implement", "implement"]);
    assert_eq!(h.runs.run().status, WorkflowRunStatus::Running);
    assert_eq!(h.runs.run().nodes["implement"].attempts.len(), 2);
    h.fake.finish(
        "implement",
        success_for(&h.def, "implement", Some("sha-retry")),
    );
    settle_all().await;
    assert_eq!(
        outcome(&h.runs.run(), "implement"),
        WorkflowNodeOutcome::Succeeded
    );
    assert_eq!(h.fake.started()[2..], ["qa", "security"]);
}

#[tokio::test]
async fn an_environment_failure_pauses_the_run_and_a_retry_continues_it() {
    let h = with_checks_running(Setup::default()).await;
    h.fake.finish(
        "security",
        StageOutcome {
            pause: Some(WorkflowPauseReason::Environment),
            ..StageOutcome::failure("audit endpoint returned an error")
        },
    );
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(run.status, WorkflowRunStatus::Running);
    assert_eq!(
        run.nodes["security"].attempts.last().and_then(|a| a.pause),
        Some(WorkflowPauseReason::Environment)
    );
    assert_eq!(
        outcome(&run, "qa"),
        WorkflowNodeOutcome::Running,
        "the sibling was left to finish"
    );
    assert!(h.fake.cancelled().is_empty());

    h.fake.finish("qa", success_for(&h.def, "qa", None));
    settle_all().await;
    assert_eq!(outcome(&h.runs.run(), "qa"), WorkflowNodeOutcome::Succeeded);

    h.orchestrator
        .update_run("run-1", |current| {
            apply_command(
                current,
                &WorkflowRunCommand::NodeRetry {
                    node_id: "security".into(),
                    at: at(),
                },
            )
        })
        .await
        .expect("retry");
    h.orchestrator.step("run-1").await;
    settle_all().await;
    assert_eq!(
        h.fake
            .started()
            .iter()
            .filter(|id| *id == "security")
            .count(),
        2
    );
    h.fake
        .finish("security", success_for(&h.def, "security", None));
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(outcome(&run, "security"), WorkflowNodeOutcome::Succeeded);
    assert_eq!(outcome(&run, "gates"), WorkflowNodeOutcome::Succeeded);
    assert_eq!(run.status, WorkflowRunStatus::Running);
}

// ── When a stage's AI runs out of budget ─────────────────────────────────

fn out_of_budget() -> StageOutcome {
    StageOutcome {
        pause: Some(WorkflowPauseReason::ProviderLimit),
        provider: Some("openai".into()),
        ..StageOutcome::failure("Insufficient balance.")
    }
}

fn policy_setup(
    policy: Option<WorkflowProviderLimitPolicy>,
    choice: Option<&'static str>,
) -> (Setup, Arc<Chooser>) {
    let mut def = definition();
    def["nodes"][0]["agent"]["providerId"] = json!("openai");
    let chooser = Arc::new(Chooser(choice, Mutex::new(Vec::new())));
    (
        Setup {
            def,
            chooser: Some(Arc::clone(&chooser)),
            customize: Box::new(move |input| {
                input.ai_provider = Some("anthropic".into());
                input.provider_limit_policy = policy;
            }),
            ..Setup::default()
        },
        chooser,
    )
}

async fn run_out(setup: Setup) -> Harness {
    let h = harness(setup);
    h.orchestrator.step("run-1").await;
    settle_all().await;
    h.fake.finish("implement", out_of_budget());
    settle_all().await;
    h
}

#[tokio::test]
async fn ask_pauses_the_stage_and_waits_for_the_user() {
    let (setup, _) = policy_setup(None, Some("gemini"));
    let h = run_out(setup).await;
    let run = h.runs.run();
    assert_eq!(run.status, WorkflowRunStatus::Running);
    assert_eq!(
        run.nodes["implement"].attempts[0].provider.as_deref(),
        Some("openai")
    );
    assert_eq!(run.stage_providers, None, "nothing switched without asking");
    assert!(
        run.events
            .last()
            .expect("event")
            .message
            .contains("Implement paused: OpenAI ran out of credits or hit its usage limit")
    );
    assert_eq!(h.fake.started(), ["implement"]);
}

#[tokio::test]
async fn switch_moves_the_stage_to_the_next_ai_and_goes_again() {
    let (setup, chooser) = policy_setup(Some(WorkflowProviderLimitPolicy::Switch), Some("gemini"));
    let h = run_out(setup).await;
    let run = h.runs.run();
    assert_eq!(*lock(&chooser.1), ["implement"]);
    assert_eq!(
        run.stage_providers
            .as_ref()
            .and_then(|p| p.get("implement"))
            .map(String::as_str),
        Some("gemini")
    );
    assert!(run.events.iter().any(|e| e.kind == WorkflowRunEventKind::NodeProviderSwitched
        && e.message.contains("Implement switched from OpenAI to Google Gemini automatically after OpenAI ran out")));
    assert_eq!(h.fake.started(), ["implement", "implement"]);
    assert_eq!(outcome(&run, "implement"), WorkflowNodeOutcome::Running);
}

#[tokio::test]
async fn switch_with_no_other_ai_stops_the_run_and_says_why() {
    let (setup, _) = policy_setup(Some(WorkflowProviderLimitPolicy::Switch), None);
    let run = run_out(setup).await.runs.run();
    assert_eq!(run.status, WorkflowRunStatus::Failed);
    assert_eq!(
        run.ended_reason.as_deref(),
        Some(
            "The run could not be completed: OpenAI ran out of credits or hit its usage limit at Implement (no other AI is set up to switch to)."
        )
    );
}

#[tokio::test]
async fn stop_ends_the_run_and_switching_later_picks_it_back_up() {
    let (setup, _) = policy_setup(Some(WorkflowProviderLimitPolicy::Stop), Some("gemini"));
    let h = run_out(setup).await;
    let run = h.runs.run();
    assert_eq!(run.status, WorkflowRunStatus::Failed);
    assert_eq!(
        run.ended_reason.as_deref(),
        Some(
            "The run could not be completed: OpenAI ran out of credits or hit its usage limit at Implement."
        )
    );
    h.runs.put(apply_command(
        run,
        &WorkflowRunCommand::StageProviderSwitched {
            node_id: "implement".into(),
            at: at(),
            provider: "claude-code-cli".into(),
            model: None,
            automatic: None,
        },
    ));
    h.orchestrator.step("run-1").await;
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(run.status, WorkflowRunStatus::Running);
    assert_eq!(
        run.stage_providers
            .as_ref()
            .and_then(|p| p.get("implement"))
            .map(String::as_str),
        Some("claude-code-cli")
    );
    assert_eq!(h.fake.started(), ["implement", "implement"]);
}

// ── Graceful shutdown ────────────────────────────────────────────────────

#[tokio::test]
async fn graceful_shutdown_persists_interruption_before_abort_without_a_repair_verdict() {
    let mut def = definition();
    def["edges"].as_array_mut().expect("edges").push(json!({
        "id": "qa-repair", "from": "qa", "to": "implement", "on": "failure", "required": false, "loop": { "maxIterations": 2 }
    }));
    let h = with_checks_running(Setup {
        def,
        ..Setup::default()
    })
    .await;
    let runs = Arc::clone(&h.runs);
    *lock(&h.fake.on_cancel) = Some(Box::new(move |node_id| {
        let pause = runs.run().nodes[node_id]
            .attempts
            .last()
            .and_then(|a| a.pause);
        assert_eq!(
            pause,
            Some(WorkflowPauseReason::Environment),
            "interruption is durable before cancellation"
        );
    }));
    let implementation = h.runs.run().nodes["implement"].clone();
    h.orchestrator.suspend().await.expect("suspend");
    h.orchestrator.suspend().await.expect("suspend again");
    h.orchestrator.step("run-1").await;
    settle_all().await;
    let run = h.runs.run();
    assert_eq!(run.status, WorkflowRunStatus::Running);
    assert_eq!(run.nodes["implement"], implementation);
    let mut cancelled = h.fake.cancelled();
    cancelled.sort();
    assert_eq!(cancelled, ["qa", "security"]);
    assert_eq!(h.fake.started(), ["implement", "qa", "security"]);
    assert_eq!(run.loop_history.as_ref().map_or(0, Vec::len), 0);
    assert!(h.orchestrator.in_flight_stages().is_empty());
}

#[tokio::test]
async fn shutdown_refuses_to_abort_a_stage_when_recording_its_interruption_fails() {
    let h = harness(Setup::default());
    h.orchestrator.step("run-1").await;
    settle_all().await;
    *lock(&h.runs.refuse) = Some(Box::new(|run: &WorkflowRun| {
        run.nodes["implement"].attempts.last().and_then(|a| a.pause)
            == Some(WorkflowPauseReason::Environment)
    }));
    let error = h.orchestrator.suspend().await.expect_err("suspend refuses");
    assert!(error.contains("disk unavailable"));
    assert!(h.fake.cancelled().is_empty());
    assert_eq!(
        outcome(&h.runs.run(), "implement"),
        WorkflowNodeOutcome::Running
    );
    *lock(&h.runs.refuse) = None;
    h.orchestrator.suspend().await.expect("suspend");
    assert_eq!(h.fake.cancelled(), ["implement"]);
    assert_eq!(
        h.runs.run().nodes["implement"]
            .attempts
            .last()
            .and_then(|a| a.pause),
        Some(WorkflowPauseReason::Environment)
    );
}

#[test]
fn the_check_node_type_is_dispatchable() {
    assert!(matches!(
        parse(definition()).node("qa"),
        Some(WorkflowNode::Check(_))
    ));
}
