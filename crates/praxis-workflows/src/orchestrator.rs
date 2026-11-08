//! Workflow orchestration loop (`workflowOrchestrator.ts` port, FX-BE-024).
//!
//! The impure counterpart to the pure scheduler: on every run transition, work out what
//! may start, start it, apply the outcome, and go round again. Three invariants:
//!
//! - **The run record is the only state.** The in-flight set only stops a second launch
//!   racing the first persist; restart needs no orchestrator state.
//! - **Persist before launch.** A stage is saved `running` before its work starts, so a
//!   crash leaves an interrupted attempt rather than work done behind a `pending` record.
//! - **One step at a time per run.** Work on a run is serialised behind a per-run async
//!   lock, so two triggers cannot both dispatch the same ready node.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::edges::{PendingLoopKind, pending_loop};
use crate::recovery::find_timed_out_nodes;
use crate::run::{
    DeclaredArtifact, ReworkOptions, StageIndependence, WorkflowMapItemState, WorkflowPauseReason,
    WorkflowProviderLimitPolicy, WorkflowRun, WorkflowRunCommand, apply_workflow_run_command,
    attempts_spent, downstream_node_ids, is_run_settled, rework_workflow_run,
};
use crate::scheduler::{advance_joins, schedule_workflow_run};
use crate::types::{
    CheckFindings, WorkflowAgentTaskNode, WorkflowCheckNode, WorkflowMapNode, WorkflowMergeNode,
    WorkflowNode, WorkflowNodeOutcome,
};

/// Several automatic recoveries from interrupted agent transport before surfacing the failure.
const MAX_AUTOMATIC_ABORT_ATTEMPTS: usize = 5;

/// What a dispatched stage reports back.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StageOutcome {
    pub succeeded: bool,
    pub error: Option<String>,
    /// An unexpected agent-session abort the orchestrator may retry automatically.
    pub retryable: bool,
    pub exit_code: Option<i64>,
    pub snapshot_ref: Option<String>,
    pub assessed_snapshot_ref: Option<String>,
    pub artifacts: Option<Vec<DeclaredArtifact>>,
    pub findings: Option<CheckFindings>,
    /// A failure that says nothing about the work; the run pauses on it.
    pub pause: Option<WorkflowPauseReason>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub independence: Option<StageIndependence>,
    pub map_items: Option<Vec<WorkflowMapItemState>>,
    pub conflict_files: Option<Vec<String>>,
}

impl StageOutcome {
    /// A plain success.
    #[must_use]
    pub fn success() -> Self {
        Self {
            succeeded: true,
            ..Self::default()
        }
    }

    /// A plain failure with a reason.
    #[must_use]
    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            succeeded: false,
            error: Some(error.into()),
            ..Self::default()
        }
    }
}

/// Lets a running stage report its session id and progress back onto the run.
#[derive(Clone)]
pub struct StageReporter {
    inner: Arc<Inner>,
    run_id: String,
    node_id: String,
}

impl StageReporter {
    /// Records the attempt's session id so a crash mid-stage still leaves it traceable.
    pub fn report_session(&self, session_id: &str) {
        let (inner, run_id, node_id, session_id) = (
            Arc::clone(&self.inner),
            self.run_id.clone(),
            self.node_id.clone(),
            session_id.to_string(),
        );
        tokio::spawn(async move { inner.record_session(&run_id, &node_id, &session_id).await });
    }

    /// Persists a bounded human-readable milestone in the run's event stream.
    pub fn report_progress(&self, message: &str) {
        let trimmed = message.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        let (inner, run_id, node_id) = (
            Arc::clone(&self.inner),
            self.run_id.clone(),
            self.node_id.clone(),
        );
        tokio::spawn(async move { inner.record_progress(&run_id, &node_id, trimmed).await });
    }
}

/// What a stage receives when it is dispatched.
#[derive(Clone)]
pub struct StageDispatchContext {
    pub run: WorkflowRun,
    /// Cancelled when the stage must stop (timeout, cancellation, shutdown).
    pub cancel: CancellationToken,
    pub worktree_path: Option<String>,
    pub reporter: StageReporter,
}

/// How stages actually execute. The host supplies process spawning and agent sessions;
/// tests supply fakes.
#[async_trait]
pub trait StageDispatcher: Send + Sync {
    /// Whether this dispatcher will run the stage. A declined stage stays `ready` for a
    /// person to advance; consulted before the stage is marked running.
    fn can_dispatch(&self, _node: &WorkflowNode, _run: &WorkflowRun) -> bool {
        true
    }
    async fn run_check(
        &self,
        node: &WorkflowCheckNode,
        context: &StageDispatchContext,
    ) -> Result<StageOutcome, String>;
    /// Runs an agent stage; report its session through `context.reporter` as soon as known.
    async fn run_agent_stage(
        &self,
        node: &WorkflowAgentTaskNode,
        context: &StageDispatchContext,
    ) -> Result<StageOutcome, String>;
    async fn run_merge(
        &self,
        _node: &WorkflowMergeNode,
        _context: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        Err("Merge stage dispatcher is not configured.".to_string())
    }
    async fn run_map(
        &self,
        _node: &WorkflowMapNode,
        _context: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        Err("This host cannot run map stages.".to_string())
    }
    /// Stops a stage that has outrun its timeout or whose run was cancelled.
    async fn cancel_stage(&self, _node_id: &str, _run: &WorkflowRun) -> Result<(), String> {
        Ok(())
    }
}

/// Where runs are stored.
#[async_trait]
pub trait WorkflowRunPersistence: Send + Sync {
    fn get(&self, run_id: &str) -> Option<WorkflowRun>;
    async fn save(&self, run: WorkflowRun) -> Result<WorkflowRun, String>;
}

/// Prepares and tears down the single worktree a run's stages share.
#[async_trait]
pub trait WorkflowWorkspaceProvider: Send + Sync {
    async fn acquire(&self, run: &WorkflowRun) -> Result<String, String>;
    async fn base_ref(
        &self,
        _run: &WorkflowRun,
        _worktree_path: &str,
    ) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn release(&self, run: &WorkflowRun) -> Result<(), String>;
    /// Whether [`Self::restore`] is implemented (keep-best loops, FX-BE-166).
    fn can_restore(&self) -> bool {
        false
    }
    /// Puts the worktree back to `reference`'s content as a new commit on the run's branch.
    async fn restore(&self, _run: &WorkflowRun, _reference: &str) -> Result<(), String> {
        Err("this host cannot restore a worktree".to_string())
    }
}

/// Picks the next AI for a stage whose AI ran out, under the `switch` policy.
#[async_trait]
pub trait FallbackProviderChooser: Send + Sync {
    async fn choose(&self, run: &WorkflowRun, node_id: &str) -> Option<String>;
}

/// Called after every persisted transition — the run-changed push channel.
pub type RunChangedListener = Arc<dyn Fn(&WorkflowRun) + Send + Sync>;

/// Returns the current time as an ISO string.
pub type Clock = Arc<dyn Fn() -> String + Send + Sync>;

/// Wiring for [`WorkflowOrchestrator`].
pub struct WorkflowOrchestratorOptions {
    pub runs: Arc<dyn WorkflowRunPersistence>,
    pub dispatcher: Arc<dyn StageDispatcher>,
    /// Omit for workflows that need no worktree.
    pub workspace: Option<Arc<dyn WorkflowWorkspaceProvider>>,
    /// Notified after every persisted transition.
    pub on_run_changed: Option<RunChangedListener>,
    pub choose_fallback_provider: Option<Arc<dyn FallbackProviderChooser>>,
    /// Injectable clock (ISO strings).
    pub now: Option<Clock>,
}

struct Execution {
    cancel: CancellationToken,
    done: watch::Receiver<bool>,
}

struct Inner {
    options: WorkflowOrchestratorOptions,
    in_flight: Mutex<HashSet<String>>,
    executions: Mutex<HashMap<String, Execution>>,
    chains: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    suspending: AtomicBool,
}

/// Drives runs forward. Cheap to clone; clones share state.
#[derive(Clone)]
pub struct WorkflowOrchestrator {
    inner: Arc<Inner>,
}

fn key(run_id: &str, node_id: &str) -> String {
    format!("{run_id}:{node_id}")
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn is_dispatchable(node: &WorkflowNode) -> bool {
    matches!(
        node,
        WorkflowNode::Check(_)
            | WorkflowNode::AgentTask(_)
            | WorkflowNode::Merge(_)
            | WorkflowNode::Map(_)
    )
}

impl WorkflowOrchestrator {
    /// Creates an orchestrator over the given ports.
    #[must_use]
    pub fn new(options: WorkflowOrchestratorOptions) -> Self {
        Self {
            inner: Arc::new(Inner {
                options,
                in_flight: Mutex::new(HashSet::new()),
                executions: Mutex::new(HashMap::new()),
                chains: Mutex::new(HashMap::new()),
                suspending: AtomicBool::new(false),
            }),
        }
    }

    /// Advances a run as far as it can go right now. Extra calls are cheap no-ops.
    pub async fn step(&self, run_id: &str) {
        Inner::step(&self.inner, run_id).await;
    }

    /// Stages currently launched, for diagnostics and tests.
    #[must_use]
    pub fn in_flight_stages(&self) -> Vec<String> {
        let mut stages: Vec<String> = locked(&self.inner.in_flight).iter().cloned().collect();
        stages.sort();
        stages
    }

    /// Persists interruption of every running stage, then stops them, so a graceful quit
    /// cannot become a code failure. Errors (and leaves processes running) when recording
    /// the interruption fails, so the host can refuse the quit.
    pub async fn suspend(&self) -> Result<(), String> {
        let inner = &self.inner;
        inner.suspending.store(true, Ordering::SeqCst);
        let result = inner.suspend_active_stages().await;
        if result.is_err() {
            inner.suspending.store(false, Ordering::SeqCst);
        }
        result
    }

    /// Applies timeouts for one run: stop the stage, then record the timeout.
    pub async fn enforce_timeouts(&self, run_id: &str) {
        let inner = Arc::clone(&self.inner);
        let id = run_id.to_string();
        let _ = self
            .inner
            .enqueue(run_id, "timeouts", async move {
                let Some(run) = inner.options.runs.get(&id) else {
                    return Ok(());
                };
                if is_run_settled(&run) {
                    return Ok(());
                }
                for node_id in find_timed_out_nodes(&run, &inner.now()) {
                    inner.stop_stage(&run, &node_id).await?;
                    let current = inner.options.runs.get(&id).unwrap_or_else(|| run.clone());
                    let command = WorkflowRunCommand::NodeTimedOut {
                        node_id,
                        at: inner.now(),
                    };
                    inner.persist_command(current, &command).await?;
                }
                Ok(())
            })
            .await;
        self.step(run_id).await;
    }

    /// Stops execution before recording cancellation, then steps (which releases the worktree).
    pub async fn cancel(&self, run_id: &str, reason: Option<&str>) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let (id, reason) = (run_id.to_string(), reason.map(str::to_string));
        self.inner
            .enqueue(run_id, "cancel", async move {
                let run = inner
                    .options
                    .runs
                    .get(&id)
                    .ok_or_else(|| format!("Run {id} was not found."))?;
                let active: Vec<String> = run
                    .nodes
                    .keys()
                    .filter(|node_id| locked(&inner.executions).contains_key(&key(&id, node_id)))
                    .cloned()
                    .collect();
                let mut failure = None;
                for node_id in active {
                    if let Err(error) = inner.stop_stage(&run, &node_id).await {
                        failure.get_or_insert(error);
                    }
                }
                if let Some(error) = failure {
                    return Err(error);
                }
                let current = inner.options.runs.get(&id).unwrap_or(run);
                inner
                    .persist_command(
                        current,
                        &WorkflowRunCommand::Cancel {
                            at: inner.now(),
                            reason,
                        },
                    )
                    .await?;
                Ok(())
            })
            .await?;
        self.step(run_id).await;
        Ok(())
    }

    /// Merges host metadata into the latest record, serialised with the run's other work.
    pub async fn update_run<F>(&self, run_id: &str, update: F) -> Result<(), String>
    where
        F: FnOnce(WorkflowRun) -> WorkflowRun + Send + 'static,
    {
        let inner = Arc::clone(&self.inner);
        let id = run_id.to_string();
        self.inner
            .enqueue(run_id, "update", async move {
                let run = inner
                    .options
                    .runs
                    .get(&id)
                    .ok_or_else(|| format!("Run {id} was not found."))?;
                inner.persist(update(run)).await?;
                Ok(())
            })
            .await
    }
}

impl Inner {
    fn now(&self) -> String {
        self.options.now.as_ref().map_or_else(
            || chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            |now| now(),
        )
    }

    fn chain(&self, run_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(locked(&self.chains).entry(run_id.to_string()).or_default())
    }

    /// Serialises work on a run. A failure never poisons the chain; it is reported to the
    /// caller (and to stderr), and the next trigger retries.
    async fn enqueue<F>(&self, run_id: &str, label: &str, work: F) -> Result<(), String>
    where
        F: Future<Output = Result<(), String>> + Send,
    {
        let chain = self.chain(run_id);
        let _guard = chain.lock().await;
        let result = work.await;
        if let Err(error) = &result {
            eprintln!("[workflow] {label} failed for run {run_id}: {error}");
        }
        result
    }

    async fn persist(&self, run: WorkflowRun) -> Result<WorkflowRun, String> {
        let saved = self.options.runs.save(run).await?;
        if let Some(notify) = &self.options.on_run_changed {
            notify(&saved);
        }
        Ok(saved)
    }

    /// Applies a command and persists the result; a no-op command persists nothing.
    async fn persist_command(
        &self,
        run: WorkflowRun,
        command: &WorkflowRunCommand,
    ) -> Result<WorkflowRun, String> {
        match apply_workflow_run_command(&run, command) {
            Some(next) => self.persist(next).await,
            None => Ok(run),
        }
    }

    async fn stop_stage(&self, run: &WorkflowRun, node_id: &str) -> Result<(), String> {
        let done = {
            let executions = locked(&self.executions);
            executions.get(&key(&run.run_id, node_id)).map(|execution| {
                execution.cancel.cancel();
                execution.done.clone()
            })
        };
        let cancelled = self.options.dispatcher.cancel_stage(node_id, run).await;
        // Wait for the execution itself, not its settle: the settle is queued behind us.
        if let Some(mut done) = done {
            let _ = done.wait_for(|finished| *finished).await;
        }
        cancelled
    }

    fn has_execution_for(&self, run_id: &str) -> bool {
        let prefix = format!("{run_id}:");
        locked(&self.executions)
            .keys()
            .any(|k| k.starts_with(&prefix))
    }

    async fn step(self: &Arc<Self>, run_id: &str) {
        let inner = Arc::clone(self);
        let id = run_id.to_string();
        let _ = self
            .enqueue(run_id, "step", async move { inner.step_once(&id).await })
            .await;
    }

    async fn suspend_active_stages(&self) -> Result<(), String> {
        let run_ids: Vec<String> = locked(&self.chains).keys().cloned().collect();
        // Drain work already queued; the suspending flag stops new dispatch.
        for run_id in &run_ids {
            let chain = self.chain(run_id);
            drop(chain.lock().await);
        }
        let active: Vec<(String, Vec<String>)> = run_ids
            .iter()
            .filter_map(|run_id| {
                let run = self.options.runs.get(run_id)?;
                if is_run_settled(&run) {
                    return None;
                }
                let running: Vec<String> = run
                    .nodes
                    .values()
                    .filter(|s| s.outcome == WorkflowNodeOutcome::Running)
                    .map(|s| s.node_id.clone())
                    .collect();
                (!running.is_empty()).then(|| (run_id.clone(), running))
            })
            .collect();
        // Record every interruption before aborting anything.
        for (run_id, node_ids) in &active {
            self.enqueue(run_id, "update", async {
                let mut run = self
                    .options
                    .runs
                    .get(run_id)
                    .ok_or_else(|| format!("Run {run_id} was not found."))?;
                for node_id in node_ids {
                    let command = WorkflowRunCommand::NodeInterrupted {
                        node_id: node_id.clone(),
                        at: self.now(),
                    };
                    if let Some(next) = apply_workflow_run_command(&run, &command) {
                        run = next;
                    }
                }
                self.persist(run).await?;
                Ok(())
            })
            .await?;
        }
        for (run_id, node_ids) in &active {
            if let Some(run) = self.options.runs.get(run_id) {
                for node_id in node_ids {
                    let _ = self.stop_stage(&run, node_id).await;
                }
            }
        }
        // Late abort results settle behind the interruption and cannot replace its pause.
        for run_id in &run_ids {
            let chain = self.chain(run_id);
            drop(chain.lock().await);
        }
        Ok(())
    }

    // ── The loop ───────────────────────────────────────────────────────────

    #[allow(clippy::too_many_lines)]
    async fn step_once(self: &Arc<Self>, run_id: &str) -> Result<(), String> {
        loop {
            if self.suspending.load(Ordering::SeqCst) {
                return Ok(());
            }
            let Some(mut run) = self.options.runs.get(run_id) else {
                return Ok(());
            };

            // A keep-best restore lands before any stage builds on the worktree.
            if run.pending_restore.is_some() {
                run = self.apply_restore(run).await?;
            }
            if is_run_settled(&run) {
                return self.release_workspace(run).await;
            }

            // A firing loop edge is taken once nothing in the run is still running.
            if let Some((kind, status)) = pending_loop(&run) {
                let busy = run
                    .nodes
                    .values()
                    .any(|s| s.outcome == WorkflowNodeOutcome::Running)
                    || self.has_execution_for(run_id);
                if kind != PendingLoopKind::Take || busy {
                    return Ok(());
                }
                let command = WorkflowRunCommand::LoopTaken {
                    edge_id: status.edge.id.clone(),
                    at: self.now(),
                };
                let Some(looped) = apply_workflow_run_command(&run, &command) else {
                    return Ok(());
                };
                run = self.persist(looped).await?;
                if run.pending_restore.is_some() {
                    run = self.apply_restore(run).await?;
                }
            }

            // Joins carry no work: settle them synchronously.
            let joined = advance_joins(run.clone(), &self.now());
            if joined != run {
                run = self.persist(joined).await?;
                if is_run_settled(&run) {
                    return self.release_workspace(run).await;
                }
            }

            let schedule = schedule_workflow_run(&run);
            if run.defer_merge == Some(true)
                && let Some(merge_id) = schedule
                    .ready
                    .iter()
                    .find(|id| matches!(run.definition.node(id), Some(WorkflowNode::Merge(_))))
            {
                let command = WorkflowRunCommand::NodeSkipped {
                    node_id: merge_id.clone(),
                    at: self.now(),
                    reason: "Merge is deferred until the final ticket in this sequential schedule."
                        .to_string(),
                };
                if let Some(skipped) = apply_workflow_run_command(&run, &command) {
                    self.persist(skipped).await?;
                    continue;
                }
            }

            let launchable: Vec<String> = schedule
                .ready
                .into_iter()
                .filter(|id| !locked(&self.in_flight).contains(&key(run_id, id)))
                .filter(|id| {
                    run.definition.node(id).is_some_and(|node| {
                        is_dispatchable(node) && self.options.dispatcher.can_dispatch(node, &run)
                    })
                })
                .collect();
            if launchable.is_empty() {
                return Ok(());
            }

            // The worktree is acquired lazily, on the first stage that needs one.
            run = match self.ensure_workspace(run.clone()).await {
                Ok(run) => run,
                Err(message) => {
                    // Pause the stage that could not start: the checkout failed, not its work,
                    // so no attempt is spent and a retry tries the worktree again.
                    let (node_id, at) = (launchable[0].clone(), self.now());
                    let started = self
                        .persist_command(
                            run,
                            &WorkflowRunCommand::NodeStarted {
                                node_id: node_id.clone(),
                                at: at.clone(),
                                session_id: None,
                            },
                        )
                        .await?;
                    let failed = WorkflowRunCommand::NodeFailed {
                        node_id,
                        at,
                        error: format!("Could not set up this run's working copy: {message}"),
                        exit_code: None,
                        findings: None,
                        pause: Some(WorkflowPauseReason::Environment),
                        provider: None,
                        model: None,
                        independence: None,
                        map_items: None,
                        conflict_files: None,
                    };
                    self.persist_command(started, &failed).await?;
                    return Ok(());
                }
            };

            for node_id in launchable {
                if self.suspending.load(Ordering::SeqCst) {
                    return Ok(());
                }
                let Some(node) = run
                    .definition
                    .node(&node_id)
                    .filter(|n| is_dispatchable(n))
                    .cloned()
                else {
                    continue;
                };
                // Claim before persisting; released only when the stage settles.
                locked(&self.in_flight).insert(key(run_id, &node_id));
                let started = WorkflowRunCommand::NodeStarted {
                    node_id: node_id.clone(),
                    at: self.now(),
                    session_id: None,
                };
                run = match self.persist_command(run, &started).await {
                    Ok(run) => run,
                    Err(error) => {
                        locked(&self.in_flight).remove(&key(run_id, &node_id));
                        return Err(error);
                    }
                };
                if self.suspending.load(Ordering::SeqCst) {
                    locked(&self.in_flight).remove(&key(run_id, &node_id));
                    return Ok(());
                }
                // Fire and forget: the completion handler re-enters the loop.
                self.spawn_dispatch(run_id, node, run.clone());
            }
            return Ok(());
        }
    }

    fn spawn_dispatch(self: &Arc<Self>, run_id: &str, node: WorkflowNode, run: WorkflowRun) {
        let cancel = CancellationToken::new();
        let (done_tx, done_rx) = watch::channel(false);
        let node_key = key(run_id, node.id());
        locked(&self.executions).insert(
            node_key.clone(),
            Execution {
                cancel: cancel.clone(),
                done: done_rx,
            },
        );
        let context = StageDispatchContext {
            worktree_path: run.worktree_path.clone(),
            run,
            cancel,
            reporter: StageReporter {
                inner: Arc::clone(self),
                run_id: run_id.to_string(),
                node_id: node.id().to_string(),
            },
        };
        let inner = Arc::clone(self);
        let run_id = run_id.to_string();
        let node_id = node.id().to_string();
        let dispatcher = Arc::clone(&self.options.dispatcher);
        tokio::spawn(async move {
            // Run the stage in its own task so a panicking dispatcher fails the stage
            // rather than wedging the run.
            let work = tokio::spawn(async move {
                match &node {
                    WorkflowNode::Check(check) => dispatcher.run_check(check, &context).await,
                    WorkflowNode::Merge(merge) => dispatcher.run_merge(merge, &context).await,
                    WorkflowNode::Map(map) => dispatcher.run_map(map, &context).await,
                    WorkflowNode::AgentTask(task) => {
                        dispatcher.run_agent_stage(task, &context).await
                    }
                    _ => Err("Stage type cannot be dispatched.".to_string()),
                }
            });
            let outcome = match work.await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(error)) => StageOutcome::failure(error),
                Err(join_error) => {
                    StageOutcome::failure(format!("Stage dispatcher panicked: {join_error}"))
                }
            };
            locked(&inner.executions).remove(&node_key);
            let _ = done_tx.send(true);
            let settle_inner = Arc::clone(&inner);
            let (id, nid) = (run_id.clone(), node_id);
            let _ = inner
                .enqueue(&run_id, "settle", async move {
                    settle_inner.settle(&id, &nid, outcome).await
                })
                .await;
            locked(&inner.in_flight).remove(&node_key);
            Inner::step(&inner, &run_id).await;
        });
    }

    async fn record_session(&self, run_id: &str, node_id: &str, session_id: &str) {
        let _ = self
            .enqueue(run_id, "session attribution", async {
                let Some(mut run) = self.options.runs.get(run_id) else {
                    return Ok(());
                };
                let Some(last) = run
                    .nodes
                    .get_mut(node_id)
                    .and_then(|s| s.attempts.last_mut())
                else {
                    return Ok(());
                };
                if last.session_id.as_deref() == Some(session_id) {
                    return Ok(());
                }
                last.session_id = Some(session_id.to_string());
                self.persist(run).await?;
                Ok(())
            })
            .await;
    }

    async fn record_progress(&self, run_id: &str, node_id: &str, message: String) {
        let _ = self
            .enqueue(run_id, "stage progress", async {
                let Some(run) = self.options.runs.get(run_id) else {
                    return Ok(());
                };
                let command = WorkflowRunCommand::NodeProgress {
                    node_id: node_id.to_string(),
                    at: self.now(),
                    phase: "testing".to_string(),
                    message: Some(message),
                };
                self.persist_command(run, &command).await?;
                Ok(())
            })
            .await;
    }

    /// Applies a stage result.
    #[allow(clippy::too_many_lines)]
    async fn settle(
        &self,
        run_id: &str,
        node_id: &str,
        outcome: StageOutcome,
    ) -> Result<(), String> {
        let Some(run) = self.options.runs.get(run_id) else {
            return Ok(());
        };
        let at = self.now();
        let command = if outcome.succeeded {
            WorkflowRunCommand::NodeSucceeded {
                node_id: node_id.to_string(),
                at: at.clone(),
                artifacts: outcome.artifacts.clone(),
                exit_code: outcome.exit_code,
                snapshot_ref: outcome.snapshot_ref.clone().filter(|s| !s.is_empty()),
                assessed_snapshot_ref: outcome
                    .assessed_snapshot_ref
                    .clone()
                    .filter(|s| !s.is_empty()),
                findings: outcome.findings.clone(),
                provider: outcome.provider.clone().filter(|s| !s.is_empty()),
                model: outcome.model.clone().filter(|s| !s.is_empty()),
                independence: outcome.independence.clone(),
                map_items: outcome.map_items.clone(),
            }
        } else {
            WorkflowRunCommand::NodeFailed {
                node_id: node_id.to_string(),
                at: at.clone(),
                error: outcome
                    .error
                    .clone()
                    .unwrap_or_else(|| "Stage failed.".to_string()),
                exit_code: outcome.exit_code,
                findings: outcome.findings.clone(),
                pause: outcome.pause,
                provider: outcome.provider.clone().filter(|s| !s.is_empty()),
                model: outcome.model.clone().filter(|s| !s.is_empty()),
                independence: outcome.independence.clone(),
                map_items: outcome.map_items.clone(),
                conflict_files: outcome.conflict_files.clone().filter(|f| !f.is_empty()),
            }
        };
        let Some(next) = apply_workflow_run_command(&run, &command) else {
            return Ok(());
        };

        // A successful repair re-runs the check it repaired, and everything that checks after it.
        if outcome.succeeded
            && let Some(source) = next
                .definition
                .nodes
                .iter()
                .find_map(|candidate| match candidate {
                    WorkflowNode::Check(check)
                        if check
                            .failure_recovery
                            .as_ref()
                            .is_some_and(|r| r.repair_node_id == node_id) =>
                    {
                        Some(check.base.id.clone())
                    }
                    _ => None,
                })
        {
            let mut counted = next.clone();
            let attempts = counted
                .recovery_attempts
                .get_or_insert_with(Default::default);
            *attempts.entry(source.clone()).or_insert(0) += 1;
            let revalidate: Vec<String> = counted
                .definition
                .nodes
                .iter()
                .filter(|c| {
                    c.id() != node_id
                        && matches!(c, WorkflowNode::Check(_) | WorkflowNode::Approval(_))
                })
                .map(|c| c.id().to_string())
                .collect();
            let refreshed = rework_workflow_run(
                &counted,
                &source,
                &at,
                &ReworkOptions {
                    reset_node_ids: revalidate,
                    ..ReworkOptions::default()
                },
            );
            if refreshed.reason.is_none() {
                self.persist(refreshed.run).await?;
                return Ok(());
            }
        }

        // A new implementation snapshot invalidates evidence already gathered downstream.
        let stage_mutates = next
            .definition
            .node(node_id)
            .is_some_and(WorkflowNode::mutates_worktree);
        if stage_mutates
            && outcome.succeeded
            && outcome.snapshot_ref.as_ref().is_some_and(|s| !s.is_empty())
            && next
                .definition
                .edges
                .iter()
                .any(|edge| edge.from == node_id)
        {
            let mut downstream = downstream_node_ids(&next, node_id);
            downstream.shift_remove(node_id);
            let prior_evidence = next.nodes.values().any(|s| {
                downstream.contains(&s.node_id) && s.attempts.len() > s.revision_base.unwrap_or(0)
            }) || next
                .gate_decisions
                .iter()
                .any(|d| downstream.contains(&d.node_id));
            if prior_evidence {
                let refreshed = rework_workflow_run(
                    &next,
                    node_id,
                    &at,
                    &ReworkOptions {
                        rerun_source: Some(false),
                        ..ReworkOptions::default()
                    },
                );
                if refreshed.reason.is_none() {
                    self.persist(refreshed.run).await?;
                    return Ok(());
                }
            }
        }

        let mut saved = self.persist(next.clone()).await?;
        let failed_state = saved
            .nodes
            .get(node_id)
            .filter(|s| s.outcome == WorkflowNodeOutcome::Failed);
        let scheduled = saved.scheduled_launch_token.is_some();
        let scheduled_agent_failure = !outcome.succeeded
            && outcome.pause.is_none()
            && scheduled
            && match (saved.definition.node(node_id), failed_state) {
                (Some(WorkflowNode::AgentTask(task)), Some(state)) => {
                    attempts_spent(state) < task.max_attempts.unwrap_or(3) as usize
                }
                _ => false,
            };
        let unexpected_abort_retry = !outcome.succeeded
            && outcome.retryable
            && scheduled
            && outcome.pause.is_none()
            && failed_state
                .is_some_and(|state| state.attempts.len() <= MAX_AUTOMATIC_ABORT_ATTEMPTS);
        if (scheduled_agent_failure || unexpected_abort_retry)
            && let Some(retried) = apply_workflow_run_command(
                &saved,
                &WorkflowRunCommand::NodeRetry {
                    node_id: node_id.to_string(),
                    at: at.clone(),
                },
            )
        {
            self.persist(retried).await?;
            return Ok(());
        }

        if !outcome.succeeded
            && let Some(WorkflowNode::Check(check)) = next.definition.node(node_id)
            && let Some(recovery) = &check.failure_recovery
        {
            let completed = next
                .recovery_attempts
                .as_ref()
                .and_then(|r| r.get(node_id))
                .copied()
                .unwrap_or(0);
            if completed >= recovery.max_attempts {
                let skip = WorkflowRunCommand::NodeSkipped {
                    node_id: recovery.repair_node_id.clone(),
                    at: at.clone(),
                    reason: "Automatic QA recovery budget exhausted.".to_string(),
                };
                saved = self.persist_command(saved, &skip).await?;
            }
        }
        if outcome.pause == Some(WorkflowPauseReason::ProviderLimit) && !is_run_settled(&saved) {
            saved = self.apply_provider_limit_policy(saved, node_id).await?;
        }
        // A run that just ended has no use for siblings still working: stop and record them.
        if is_run_settled(&saved) {
            self.stop_in_flight(&saved).await?;
        }
        Ok(())
    }

    /// `ask` leaves the stage paused; `switch` moves it to the next AI (stopping when there
    /// is none); `stop` ends the run saying why.
    async fn apply_provider_limit_policy(
        &self,
        run: WorkflowRun,
        node_id: &str,
    ) -> Result<WorkflowRun, String> {
        match run
            .provider_limit_policy
            .unwrap_or(WorkflowProviderLimitPolicy::Ask)
        {
            WorkflowProviderLimitPolicy::Ask => Ok(run),
            WorkflowProviderLimitPolicy::Switch => {
                let provider = match &self.options.choose_fallback_provider {
                    Some(chooser) => chooser.choose(&run, node_id).await,
                    None => None,
                };
                if let Some(provider) = provider.filter(|p| !p.is_empty()) {
                    let command = WorkflowRunCommand::StageProviderSwitched {
                        node_id: node_id.to_string(),
                        at: self.now(),
                        provider,
                        model: None,
                        automatic: Some(true),
                    };
                    return self.persist_command(run, &command).await;
                }
                // An independent reviewer whose only way forward is the author's own AI waits
                // for a person rather than quietly reviewing itself.
                if matches!(run.definition.node(node_id), Some(WorkflowNode::AgentTask(t)) if t.independent_of.is_some())
                {
                    return Ok(run);
                }
                let command = WorkflowRunCommand::ProviderLimitStop {
                    node_id: node_id.to_string(),
                    at: self.now(),
                    detail: Some("no other AI is set up to switch to".to_string()),
                };
                self.persist_command(run, &command).await
            }
            WorkflowProviderLimitPolicy::Stop => {
                let command = WorkflowRunCommand::ProviderLimitStop {
                    node_id: node_id.to_string(),
                    at: self.now(),
                    detail: None,
                };
                self.persist_command(run, &command).await
            }
        }
    }

    async fn stop_in_flight(&self, run: &WorkflowRun) -> Result<(), String> {
        let running: Vec<String> = run
            .nodes
            .values()
            .filter(|s| s.outcome == WorkflowNodeOutcome::Running)
            .map(|s| s.node_id.clone())
            .collect();
        if running.is_empty() {
            return Ok(());
        }
        for node_id in &running {
            if locked(&self.executions).contains_key(&key(&run.run_id, node_id)) {
                let _ = self.stop_stage(run, node_id).await;
            }
        }
        let mut current = self
            .options
            .runs
            .get(&run.run_id)
            .unwrap_or_else(|| run.clone());
        let reason = format!(
            "the run ended ({}).",
            run.ended_reason
                .clone()
                .unwrap_or_else(|| serde_json::to_value(run.status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default())
        );
        let mut changed = false;
        for node_id in running {
            let command = WorkflowRunCommand::NodeStopped {
                node_id,
                at: self.now(),
                reason: Some(reason.clone()),
            };
            if let Some(next) = apply_workflow_run_command(&current, &command) {
                current = next;
                changed = true;
            }
        }
        if changed {
            self.persist(current).await?;
        }
        Ok(())
    }

    // ── Workspace ──────────────────────────────────────────────────────────

    async fn apply_restore(&self, run: WorkflowRun) -> Result<WorkflowRun, String> {
        let Some(restore) = run.pending_restore.clone() else {
            return Ok(run);
        };
        let (ok, detail) = match &self.options.workspace {
            Some(workspace) if workspace.can_restore() => {
                if run.worktree_path.is_none() {
                    (false, Some("the run has no worktree".to_string()))
                } else {
                    match workspace.restore(&run, &restore.reference).await {
                        Ok(()) => (true, None),
                        Err(error) => (false, Some(error)),
                    }
                }
            }
            _ => (
                false,
                Some("this host cannot restore a worktree".to_string()),
            ),
        };
        self.persist_command(
            run,
            &WorkflowRunCommand::LoopRestored {
                at: self.now(),
                ok,
                detail,
            },
        )
        .await
    }

    async fn ensure_workspace(&self, mut run: WorkflowRun) -> Result<WorkflowRun, String> {
        let Some(workspace) = &self.options.workspace else {
            return Ok(run);
        };
        if run.worktree_path.is_some() {
            return Ok(run);
        }
        let path = workspace.acquire(&run).await?;
        let base = workspace.base_ref(&run, &path).await?;
        run.worktree_path = Some(path);
        if let Some(base) = base.filter(|b| !b.is_empty()) {
            run.worktree_base_ref = Some(base);
        }
        self.persist(run).await
    }

    async fn release_workspace(&self, mut run: WorkflowRun) -> Result<(), String> {
        let Some(workspace) = &self.options.workspace else {
            return Ok(());
        };
        if run.worktree_path.is_none() || self.has_execution_for(&run.run_id) {
            return Ok(());
        }
        if let Err(error) = workspace.release(&run).await {
            // Keep the path so cleanup can be retried, including after restart.
            eprintln!(
                "[workflow] could not release the worktree for run {}: {error}",
                run.run_id
            );
            return Ok(());
        }
        run.worktree_path = None;
        self.persist(run).await?;
        Ok(())
    }
}
