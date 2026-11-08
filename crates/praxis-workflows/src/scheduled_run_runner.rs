//! The scheduled-run runner (`scheduledRunRunner.ts` port).
//!
//! Orchestration only: every decision about *what happens to a run* is a pure transition in
//! [`crate::scheduled_run_execution`] / [`crate::scheduled_budget`], and every side effect
//! (storage, the workflow engine, provider usage, the clock) is a port. That is what lets restart
//! recovery, ordering and the allowance hand-over be unit-tested with fakes.
//!
//! Three guarantees the design is built around:
//!
//! - **Never launch a ticket twice.** The entry is saved as `running` with a `launch_token` *before*
//!   the workflow is launched, and the token travels on the workflow run. After a crash the entry is
//!   found again by token; if there is no run for it, the schedule pauses (`launch-interrupted`) and
//!   asks.
//! - **Never drop a change.** All work for one schedule goes through one chain, so a
//!   workflow-change event that arrives mid-step queues behind it instead of being ignored.
//! - **Never move past a failure by itself.** A failed ticket pauses the run; the user retries,
//!   skips or stops.
//!
//! A parallel run fills free lanes one launch at a time, each with the same save-before-launch
//! guarantee. A lane beyond the first starts only when the step allows it and the provider's
//! reported allowance has room for every ticket on it; otherwise the run uses fewer lanes and says
//! why.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::Mutex as AsyncMutex;

use crate::scheduled_budget::{
    DEFAULT_HANDOVER_THRESHOLD, ExtraLaneInput, ProviderBudgetInput, ProviderDecision,
    ProviderUsage, decide_extra_lane, decide_provider_for_entry,
};
use crate::scheduled_run::{
    ScheduledEntryStatus, ScheduledHandover, ScheduledPauseReason, ScheduledQueueEntry,
    ScheduledRun, ScheduledRunEventKind, ScheduledRunPolicyMode, ScheduledRunStatus,
    ScheduledTicketRef, due_scheduled_runs, scheduled_concurrency, scheduled_steps,
    start_scheduled_run_now,
};
use crate::scheduled_run_execution::{
    EntryProgress, EntryProgressKind, ScheduledLane, active_scheduled_entries,
    apply_entry_progress, bind_entry_workflow, cancel_scheduled_run, complete_if_drained,
    free_scheduled_lane, launchable_entries, mark_entry_launching, pause_scheduled_run,
    record_budget_check, record_provider_handover, record_scheduled_decision, resume_scheduled_run,
    retry_scheduled_entry, skip_scheduled_entry, start_scheduled_run_attempt,
};
use crate::scheduled_ticket_status::ScheduledTicketPhase;

/// A workflow run as the runner sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowObservation {
    pub progress: EntryProgress,
    /// Informational: false while an agent turn is in flight. The handover port owns safe interruption.
    pub idle: Option<bool>,
}

/// What the host knows about the AI providers right now.
#[derive(Debug, Clone, Default)]
pub struct ProviderUsageReading {
    /// Providers that are enabled and set up, in preference order.
    pub usable: Vec<String>,
    /// The provider new work starts on by default.
    pub active: Option<String>,
    /// Allowance used per provider as 0-1. A provider that does not report is absent.
    pub used: ProviderUsage,
}

/// What an autonomous gate decision came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledGateDecisionResult {
    /// `approved`, `rejected`, `skipped` or `reworking`.
    pub decision: String,
    pub reason: String,
}

/// What an autonomous loop decision came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledLoopDecisionResult {
    /// `accept`, `stop` or `grant`.
    pub decision: String,
    pub reason: String,
}

/// A ticket that cannot be started, with the reason the run should pause for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledLaunchError {
    pub message: String,
    /// The pause reason the run should take. `None` means the generic policy pause.
    pub reason: Option<ScheduledPauseReason>,
}

impl ScheduledLaunchError {
    /// A launch that failed for a known reason.
    #[must_use]
    pub fn with_reason(message: impl Into<String>, reason: ScheduledPauseReason) -> Self {
        Self {
            message: message.into(),
            reason: Some(reason),
        }
    }

    /// A launch that failed for no known reason: the run pauses on policy.
    #[must_use]
    pub fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            reason: None,
        }
    }
}

/// The request to start one ticket's workflow run.
#[derive(Debug, Clone)]
pub struct ScheduledLaunchRequest {
    pub run: ScheduledRun,
    pub entry: ScheduledQueueEntry,
    pub workflow_id: String,
    pub token: String,
    pub provider: Option<String>,
    pub delivery_branch_name: Option<String>,
    /// True when this is the last ticket of the run.
    pub final_entry: bool,
}

/// What a launch produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledLaunched {
    pub workflow_run_id: String,
    pub delivery_branch_name: Option<String>,
}

/// The request to move a running ticket to another provider.
#[derive(Debug, Clone)]
pub struct ScheduledHandOverRequest {
    pub run: ScheduledRun,
    pub entry: ScheduledQueueEntry,
    pub workflow_run_id: String,
    pub from: String,
    pub to: String,
    pub used_fraction: f64,
}

/// What a hand-over produced.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScheduledHandOverResult {
    /// Where the work in progress was preserved.
    pub checkpoint_ref: Option<String>,
    /// The provider the host actually handed to, when it was not the one asked for.
    pub provider: Option<String>,
}

/// The request to move a ticket on its board.
#[derive(Debug, Clone)]
pub struct ScheduledMoveTicketRequest {
    pub run: ScheduledRun,
    pub entry: ScheduledQueueEntry,
    pub phase: ScheduledTicketPhase,
}

/// Everything the runner needs from the host.
///
/// The optional ports return `None` when the host does not offer them, which is how the runner
/// tells "the host has no such capability" from "the host tried and it failed".
#[async_trait]
pub trait ScheduledRunnerPorts: Send + Sync {
    /// Every schedule the host knows about.
    async fn list(&self) -> Vec<ScheduledRun>;
    /// One schedule, or `None` when it no longer exists.
    fn get(&self, id: &str) -> Option<ScheduledRun>;
    /// Saves a schedule and returns what was stored.
    async fn save(&self, run: ScheduledRun) -> Result<ScheduledRun, String>;
    /// The current instant, as an ISO 8601 string.
    fn now(&self) -> String;
    /// Whether the host permits execution; false prevents starting or observing schedules.
    fn is_enabled(&self) -> bool;
    /// A fresh launch token.
    fn new_token(&self) -> String;
    /// What the workflow engine says about a workflow run, or `None` when it no longer exists.
    fn observe(&self, workflow_run_id: &str) -> Option<WorkflowObservation>;
    /// The workflow run launched with this token, if one exists.
    fn find_by_launch_token(&self, token: &str) -> Option<String>;
    /// A readable reason the ticket cannot be run any more (deleted, moved, closed), or `None` when
    /// it can.
    async fn check_ticket(&self, ticket: &ScheduledTicketRef) -> Result<Option<String>, String>;
    /// Starts the ticket's workflow run and returns its id.
    async fn launch(
        &self,
        request: ScheduledLaunchRequest,
    ) -> Result<ScheduledLaunched, ScheduledLaunchError>;
    /// Stops a workflow run that the schedule no longer wants.
    async fn cancel_workflow(&self, workflow_run_id: &str, reason: &str) -> Result<(), String>;
    /// How much allowance each provider has used.
    async fn usage(&self) -> Result<ProviderUsageReading, String>;
    /// Preserves work in progress and moves the run to another provider.
    async fn hand_over(
        &self,
        request: ScheduledHandOverRequest,
    ) -> Result<ScheduledHandOverResult, String>;

    /// The branch that already holds the failed intermediate ticket, so the schedule can resume it.
    async fn delivery_branch_for_workflow(
        &self,
        _workflow_run_id: &str,
    ) -> Option<Result<Option<String>, String>> {
        None
    }
    /// Evaluates an approval gate autonomously.
    async fn decide_gate(
        &self,
        _workflow_run_id: &str,
        _node_id: &str,
    ) -> Option<Result<ScheduledGateDecisionResult, String>> {
        None
    }
    /// Resolves a loop decision autonomously.
    async fn decide_loop(
        &self,
        _workflow_run_id: &str,
        _edge_id: &str,
    ) -> Option<Result<ScheduledLoopDecisionResult, String>> {
        None
    }
    /// Moves the ticket on its board into `phase`.
    async fn move_ticket(
        &self,
        _request: &ScheduledMoveTicketRequest,
    ) -> Option<Result<Option<String>, String>> {
        None
    }
    /// Approves the gate the entry is waiting at.
    async fn approve_gate(
        &self,
        _workflow_run_id: &str,
        _node_id: &str,
    ) -> Option<Result<(), String>> {
        None
    }
    /// Retries a failed stage whose attempt budget has attempts remaining.
    async fn retry_stage(
        &self,
        _workflow_run_id: &str,
        _node_id: &str,
    ) -> Option<Result<(), String>> {
        None
    }
    /// A run was saved.
    fn on_changed(&self, _run: &ScheduledRun) {}
    /// Share of an allowance (0-1) at which a provider is handed over. Read at every decision so a
    /// settings change applies at once.
    fn threshold(&self) -> Option<f64> {
        None
    }
}

/// Every provider that ran out on an earlier ticket of this run, unless a later ticket has since run
/// successfully on it.
fn exhausted_in_run(run: &ScheduledRun) -> Vec<String> {
    let mut exhausted: Vec<String> = Vec::new();
    for entry in &run.entries {
        let Some(outcome) = &entry.outcome else {
            continue;
        };
        if outcome.status == ScheduledEntryStatus::Done {
            if let Some(provider) = &outcome.provider {
                if !outcome.exhausted.contains(provider) {
                    exhausted.retain(|known| known != provider);
                }
            }
        }
        for provider in &outcome.exhausted {
            if !exhausted.contains(provider) {
                exhausted.push(provider.clone());
            }
        }
    }
    exhausted
}

/// The branch a sequential run delivers its work on.
fn scheduled_branch_name(run_id: &str) -> String {
    let trimmed = run_id.strip_prefix("run-").unwrap_or(run_id);
    let sanitized: String = trimmed
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();
    format!("WF-SR-{}", sanitized.to_uppercase())
}

/// The lane a parallel run starts an entry in, and why it may run now.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LaneChoice {
    ok: bool,
    lane: u32,
    reason: String,
}

/// The progress that stands in for a stalled observation: the entry is still running.
fn running_fallback(outcome: &crate::scheduled_run::ScheduledEntryOutcome) -> EntryProgress {
    EntryProgress {
        kind: EntryProgressKind::Running {
            provider: outcome.provider.clone(),
            session_id: None,
            spend: outcome.spend.clone(),
            exhausted: vec![],
        },
        estimate: None,
        artifacts: vec![],
    }
}

/// Puts an entry whose launch never happened back to queued without counting it as a retry.
fn requeue(mut run: ScheduledRun, entry_id: &str) -> ScheduledRun {
    for entry in &mut run.entries {
        if entry.id == entry_id {
            entry.outcome = Some(crate::scheduled_run::ScheduledEntryOutcome::queued());
            break;
        }
    }
    run
}

/// The scheduled-run runner.
pub struct ScheduledRunRunner {
    ports: Arc<dyn ScheduledRunnerPorts>,
    /// One lock per schedule, so all work for a schedule goes through one chain.
    chains: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// Entries whose launch is in flight, so recovery does not mistake them for interrupted ones.
    launching: Mutex<HashSet<String>>,
}

impl ScheduledRunRunner {
    #[must_use]
    pub fn new(ports: Arc<dyn ScheduledRunnerPorts>) -> Self {
        Self {
            ports,
            chains: Mutex::new(HashMap::new()),
            launching: Mutex::new(HashSet::new()),
        }
    }

    /// Look at every schedule once: start the due ones and advance the live ones.
    pub async fn tick(self: &Arc<Self>) {
        if !self.ports.is_enabled() {
            return;
        }
        let now = self.ports.now();
        let runs = self.ports.list().await;
        let mut ids: Vec<String> = Vec::new();
        for run in due_scheduled_runs(&runs, &now) {
            ids.push(run.id);
        }
        for run in &runs {
            if matches!(
                run.status,
                ScheduledRunStatus::Running | ScheduledRunStatus::Paused
            ) && !ids.contains(&run.id)
            {
                ids.push(run.id.clone());
            }
        }

        let mut tasks = tokio::task::JoinSet::new();
        for id in ids {
            let runner = Arc::clone(self);
            let step_id = id.clone();
            tasks.spawn(async move {
                let _ = runner
                    .enqueue(&id, move |runner| {
                        let id = step_id.clone();
                        async move { runner.advance(&id).await }
                    })
                    .await;
            });
        }
        while let Some(result) = tasks.join_next().await {
            // A panicking step must not take the daemon with it; the schedule keeps its own state.
            let _ = result;
        }
    }

    /// A workflow run changed: advance the schedule that owns it, if any.
    pub async fn handle_workflow_changed(self: &Arc<Self>, workflow_run_id: &str) {
        if !self.ports.is_enabled() {
            return;
        }
        let runs = self.ports.list().await;
        let owner = runs.iter().find(|run| {
            run.entries.iter().any(|entry| {
                entry
                    .outcome
                    .as_ref()
                    .and_then(|outcome| outcome.workflow_run_id.as_deref())
                    == Some(workflow_run_id)
            })
        });
        if let Some(owner) = owner {
            let id = owner.id.clone();
            let step_id = id.clone();
            let _ = self
                .enqueue(&id, move |runner| {
                    let id = step_id.clone();
                    async move { runner.advance(&id).await }
                })
                .await;
        }
    }

    /// Call once at startup, after missed runs were reconciled. Finds entries that were mid-launch
    /// when Praxis stopped: binds them if their workflow run exists, otherwise pauses and asks.
    /// Never relaunches by itself.
    pub async fn recover(self: &Arc<Self>) {
        if !self.ports.is_enabled() {
            return;
        }
        let runs = self.ports.list().await;
        for run in runs {
            if !matches!(
                run.status,
                ScheduledRunStatus::Running | ScheduledRunStatus::Paused
            ) {
                continue;
            }
            let id = run.id.clone();
            let step_id = id.clone();
            let _ = self
                .enqueue(&id, move |runner| {
                    let id = step_id.clone();
                    async move {
                        if let Some(current) = runner.ports.get(&id) {
                            runner.settle_interrupted_launch(current).await?;
                        }
                        Ok(())
                    }
                })
                .await;
        }
    }

    /// Starts a schedule now, at the user's request.
    pub async fn start_now(self: &Arc<Self>, run_id: &str) -> Result<ScheduledRun, String> {
        let now = self.ports.now();
        let enabled = self.ports.is_enabled();
        self.command(
            run_id,
            move |run| {
                let now = now.clone();
                async move {
                    if !enabled {
                        return Err("Scheduled run execution is unavailable.".to_string());
                    }
                    start_scheduled_run_now(run, &now)
                }
            },
            true,
        )
        .await
    }

    /// Pauses a run at the user's request.
    pub async fn pause(self: &Arc<Self>, run_id: &str) -> Result<ScheduledRun, String> {
        let now = self.ports.now();
        self.command(
            run_id,
            move |run| {
                let now = now.clone();
                async move {
                    pause_scheduled_run(
                        run,
                        ScheduledPauseReason::User,
                        "Paused by the user.",
                        &now,
                        None,
                    )
                }
            },
            false,
        )
        .await
    }

    /// Resumes a paused run at the user's request.
    pub async fn resume(self: &Arc<Self>, run_id: &str) -> Result<ScheduledRun, String> {
        let now = self.ports.now();
        self.command(
            run_id,
            move |run| {
                let now = now.clone();
                async move { resume_scheduled_run(run, &now) }
            },
            true,
        )
        .await
    }

    /// Puts a stopped ticket back at the front of the queue.
    pub async fn retry_entry(
        self: &Arc<Self>,
        run_id: &str,
        entry_id: &str,
    ) -> Result<ScheduledRun, String> {
        let now = self.ports.now();
        let entry_id = entry_id.to_string();
        self.command(
            run_id,
            move |run| {
                let now = now.clone();
                let entry_id = entry_id.clone();
                async move { retry_scheduled_entry(run, &entry_id, &now) }
            },
            true,
        )
        .await
    }

    /// Leaves a ticket out of this run; the run carries on with the next one.
    pub async fn skip_entry(
        self: &Arc<Self>,
        run_id: &str,
        entry_id: &str,
    ) -> Result<ScheduledRun, String> {
        let now = self.ports.now();
        let entry_id = entry_id.to_string();
        let runner = Arc::clone(self);
        self.command(
            run_id,
            move |run| {
                let now = now.clone();
                let entry_id = entry_id.clone();
                let runner = Arc::clone(&runner);
                async move {
                    let live = run
                        .entries
                        .iter()
                        .find(|entry| entry.id == entry_id)
                        .and_then(|entry| entry.outcome.as_ref());
                    let workflow_run_id = live.and_then(|outcome| outcome.workflow_run_id.clone());
                    let status = live.map(|outcome| outcome.status);
                    if let Some(workflow_run_id) = workflow_run_id {
                        if matches!(
                            status,
                            Some(ScheduledEntryStatus::Running)
                                | Some(ScheduledEntryStatus::Paused)
                        ) {
                            runner
                                .ports
                                .cancel_workflow(&workflow_run_id, "Skipped from the schedule.")
                                .await?;
                        }
                    }
                    skip_scheduled_entry(run, &entry_id, &now, "Skipped by the user.")
                }
            },
            true,
        )
        .await
    }

    /// Stops a run and every ticket still in flight.
    pub async fn cancel(self: &Arc<Self>, run_id: &str) -> Result<ScheduledRun, String> {
        let now = self.ports.now();
        let runner = Arc::clone(self);
        self.command(
            run_id,
            move |run| {
                let now = now.clone();
                let runner = Arc::clone(&runner);
                async move {
                    for entry in active_scheduled_entries(&run) {
                        if let Some(workflow_run_id) = entry
                            .outcome
                            .as_ref()
                            .and_then(|outcome| outcome.workflow_run_id.clone())
                        {
                            runner
                                .ports
                                .cancel_workflow(&workflow_run_id, "The scheduled run was stopped.")
                                .await?;
                        }
                    }
                    cancel_scheduled_run(run, &now, "Stopped by the user.")
                }
            },
            false,
        )
        .await
    }

    /// Approves the gate an entry is waiting at.
    pub async fn approve_gate(
        self: &Arc<Self>,
        run_id: &str,
        entry_id: &str,
    ) -> Result<ScheduledRun, String> {
        let entry_id = entry_id.to_string();
        let runner = Arc::clone(self);
        self.command(
            run_id,
            move |run| {
                let entry_id = entry_id.clone();
                let runner = Arc::clone(&runner);
                async move {
                    let outcome = run
                        .entries
                        .iter()
                        .find(|entry| entry.id == entry_id)
                        .and_then(|entry| entry.outcome.as_ref());
                    let workflow_run_id =
                        outcome.and_then(|outcome| outcome.workflow_run_id.clone());
                    let gate = outcome.and_then(|outcome| outcome.gate.clone());
                    let (Some(workflow_run_id), Some(gate)) = (workflow_run_id, gate) else {
                        return Err("That ticket is not waiting at an approval gate.".to_string());
                    };
                    let approved = runner
                        .ports
                        .approve_gate(&workflow_run_id, &gate.node_id)
                        .await
                        .ok_or_else(|| {
                            "Approving from the schedule is not available here.".to_string()
                        })?;
                    approved?;
                    Ok(run)
                }
            },
            true,
        )
        .await
    }

    /// Runs `step` once every earlier step for this schedule has finished.
    async fn enqueue<T, F, Fut>(self: &Arc<Self>, run_id: &str, step: F) -> Result<T, String>
    where
        F: FnOnce(Arc<Self>) -> Fut,
        Fut: std::future::Future<Output = Result<T, String>> + Send + 'static,
        T: Send + 'static,
    {
        let lock = {
            let mut chains = self.chains.lock().expect("scheduled run chains");
            chains
                .entry(run_id.to_string())
                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                .clone()
        };
        let guard = lock.lock().await;
        let result = step(Arc::clone(self)).await;
        drop(guard);
        {
            let mut chains = self.chains.lock().expect("scheduled run chains");
            let unused = chains
                .get(run_id)
                .is_some_and(|held| Arc::strong_count(held) == 1);
            if unused {
                chains.remove(run_id);
            }
        }
        result
    }

    /// Applies a user command, saves the result, then lets the run act on it straight away.
    async fn command<F, Fut>(
        self: &Arc<Self>,
        run_id: &str,
        apply: F,
        advance_after: bool,
    ) -> Result<ScheduledRun, String>
    where
        F: FnOnce(ScheduledRun) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<ScheduledRun, String>> + Send + 'static,
    {
        let run_id = run_id.to_string();
        let step_id = run_id.clone();
        self.enqueue(&run_id, move |runner| {
            let run_id = step_id.clone();
            async move {
                let run = runner
                    .ports
                    .get(&run_id)
                    .ok_or_else(|| "That scheduled run no longer exists.".to_string())?;
                let original = run.clone();
                let next = apply(run).await?;
                let saved = if next == original {
                    original
                } else {
                    runner.save(next).await?
                };
                if advance_after && runner.ports.is_enabled() {
                    runner.advance(&run_id).await?;
                }
                Ok(runner.ports.get(&run_id).unwrap_or(saved))
            }
        })
        .await
    }

    /// Saves a run and tells the host about it.
    async fn save(&self, run: ScheduledRun) -> Result<ScheduledRun, String> {
        let saved = self.ports.save(run).await?;
        self.ports.on_changed(&saved);
        Ok(saved)
    }
}

impl ScheduledRunRunner {
    /// Brings one schedule as far forward as it can go.
    async fn advance(self: &Arc<Self>, run_id: &str) -> Result<(), String> {
        let Some(mut run) = self.ports.get(run_id) else {
            return Ok(());
        };

        if run.status == ScheduledRunStatus::Scheduled {
            let now = self.ports.now();
            if due_scheduled_runs(&[run.clone()], &now).is_empty() {
                return Ok(());
            }
            run = self.save(start_scheduled_run_attempt(run, &now)?).await?;
        }
        if !matches!(
            run.status,
            ScheduledRunStatus::Running | ScheduledRunStatus::Paused
        ) {
            return Ok(());
        }

        run = self.settle_interrupted_launch(run).await?;
        let entry_ids: Vec<String> = active_scheduled_entries(&run)
            .into_iter()
            .map(|entry| entry.id.clone())
            .collect();
        for entry_id in entry_ids {
            run = self.observe_active(run, &entry_id).await?;
        }
        run = self.observe_recovered(run).await?;
        if run.status == ScheduledRunStatus::Running {
            self.launch_next(run).await?;
        }
        Ok(())
    }

    /// An entry that is running with a token but no workflow run was caught mid-launch.
    async fn settle_interrupted_launch(&self, run: ScheduledRun) -> Result<ScheduledRun, String> {
        if !matches!(
            run.status,
            ScheduledRunStatus::Running | ScheduledRunStatus::Paused
        ) {
            return Ok(run);
        }
        let mut current = run;
        for entry in current.entries.clone() {
            let Some(outcome) = &entry.outcome else {
                continue;
            };
            if outcome.status != ScheduledEntryStatus::Running
                || outcome.workflow_run_id.is_some()
                || outcome.launch_token.is_none()
            {
                continue;
            }
            if self
                .launching
                .lock()
                .expect("scheduled run launches")
                .contains(&entry.id)
            {
                continue;
            }
            let token = outcome.launch_token.clone().unwrap_or_default();
            let at = self.ports.now();
            if let Some(found) = self.ports.find_by_launch_token(&token) {
                current = self
                    .save(bind_entry_workflow(current, &entry.id, &found, &at)?)
                    .await?;
            } else if current.status == ScheduledRunStatus::Running {
                let message = format!(
                    "Praxis stopped while starting {}. Retry it to start it again, or skip it.",
                    entry.ticket.issue_key
                );
                current = self
                    .save(pause_scheduled_run(
                        current,
                        ScheduledPauseReason::LaunchInterrupted,
                        &message,
                        &at,
                        Some(&entry.id),
                    )?)
                    .await?;
            }
        }
        Ok(current)
    }

    /// Brings the running entry up to date with its workflow run, and hands over if its provider is
    /// nearly out.
    ///
    /// A stall on a provider's limit is recorded rather than handed over: by the time the schedule
    /// sees it the workflow's own `switch` policy has already tried every provider it could, so
    /// what is left is a note for the user and a provider the next ticket must not start on.
    async fn observe_active(
        &self,
        mut run: ScheduledRun,
        entry_id: &str,
    ) -> Result<ScheduledRun, String> {
        let Some(entry) = run.entries.iter().find(|entry| entry.id == entry_id) else {
            return Ok(run);
        };
        let issue_key = entry.ticket.issue_key.clone();
        let Some(outcome) = entry.outcome.clone() else {
            return Ok(run);
        };
        if !matches!(
            outcome.status,
            ScheduledEntryStatus::Running | ScheduledEntryStatus::Paused
        ) {
            return Ok(run);
        }
        let Some(workflow_run_id) = outcome.workflow_run_id.clone() else {
            return Ok(run);
        };

        let mut observation = self.ports.observe(&workflow_run_id);
        let mut at = self.ports.now();
        let mut progress = observation
            .as_ref()
            .map(|observation| observation.progress.clone())
            .unwrap_or_else(|| EntryProgress {
                kind: EntryProgressKind::Failed {
                    reason: "Its workflow run could not be found.".into(),
                    node_id: None,
                    spend: None,
                    exhausted: vec![],
                },
                estimate: None,
                artifacts: vec![],
            });

        if let EntryProgressKind::Gate { node_id, label, .. } = progress.kind.clone() {
            let decided = match self.ports.decide_gate(&workflow_run_id, &node_id).await {
                Some(Ok(result)) => {
                    at = self.ports.now();
                    let message = format!(
                        "{} gate \"{}\": {} — {}",
                        issue_key, label, result.decision, result.reason
                    );
                    run = self
                        .save(record_scheduled_decision(
                            run,
                            entry_id,
                            ScheduledRunEventKind::GateDecided,
                            &at,
                            &message,
                        )?)
                        .await?;
                    Some(true)
                }
                Some(Err(_)) => None,
                None => match self.ports.approve_gate(&workflow_run_id, &node_id).await {
                    Some(Ok(())) => {
                        at = self.ports.now();
                        let message =
                            format!("{} gate \"{}\": approved autonomously.", issue_key, label);
                        run = self
                            .save(record_scheduled_decision(
                                run,
                                entry_id,
                                ScheduledRunEventKind::GateDecided,
                                &at,
                                &message,
                            )?)
                            .await?;
                        Some(true)
                    }
                    Some(Err(_)) => None,
                    None => None,
                },
            };
            if decided.is_some() {
                let updated = self.ports.observe(&workflow_run_id);
                progress = match &updated {
                    Some(updated) => match &updated.progress.kind {
                        EntryProgressKind::Stalled { .. } => running_fallback(&outcome),
                        _ => updated.progress.clone(),
                    },
                    None => running_fallback(&outcome),
                };
                observation = updated;
            }
        }

        if let EntryProgressKind::Stalled {
            edge_id, recovery, ..
        } = progress.kind.clone()
        {
            if let Some(edge_id) = edge_id {
                if let Some(Ok(result)) = self.ports.decide_loop(&workflow_run_id, &edge_id).await {
                    at = self.ports.now();
                    let message = format!(
                        "{} loop decision: {} — {}",
                        issue_key, result.decision, result.reason
                    );
                    run = self
                        .save(record_scheduled_decision(
                            run,
                            entry_id,
                            ScheduledRunEventKind::LoopDecided,
                            &at,
                            &message,
                        )?)
                        .await?;
                    let updated = self.ports.observe(&workflow_run_id);
                    progress = match &updated {
                        Some(updated) => match &updated.progress.kind {
                            EntryProgressKind::Stalled { .. } => running_fallback(&outcome),
                            _ => updated.progress.clone(),
                        },
                        None => running_fallback(&outcome),
                    };
                    observation = updated;
                }
            }
            if let Some(recovery) = recovery {
                let automatic = recovery.automatic != Some(false);
                if automatic
                    && recovery.attempts < recovery.max_attempts
                    && self
                        .ports
                        .retry_stage(&workflow_run_id, &recovery.node_id)
                        .await
                        .is_some_and(|result| result.is_ok())
                {
                    at = self.ports.now();
                    let message = format!(
                        "{} {} failed (attempt {} of {}): retrying autonomously.",
                        issue_key, recovery.node_id, recovery.attempts, recovery.max_attempts
                    );
                    run = self
                        .save(record_scheduled_decision(
                            run,
                            entry_id,
                            ScheduledRunEventKind::EntryRetried,
                            &at,
                            &message,
                        )?)
                        .await?;
                    let updated = self.ports.observe(&workflow_run_id);
                    progress = match &updated {
                        Some(updated) => match &updated.progress.kind {
                            EntryProgressKind::Stalled { .. } => running_fallback(&outcome),
                            _ => updated.progress.clone(),
                        },
                        None => running_fallback(&outcome),
                    };
                    observation = updated;
                }
            }
        }

        // Moved before the finish is applied: finishing the last ticket completes the run, and the
        // ledger ends there.
        if matches!(progress.kind, EntryProgressKind::Succeeded { .. }) {
            run = self
                .move_ticket(run, entry_id, ScheduledTicketPhase::Done)
                .await?;
            at = self.ports.now();
        }
        let before = run.clone();
        let applied = apply_entry_progress(run, entry_id, &progress, &at)?;
        let mut next = if applied == before {
            applied
        } else {
            self.save(applied).await?
        };

        let stalled_on_budget = matches!(
            observation
                .as_ref()
                .map(|observation| &observation.progress.kind),
            Some(EntryProgressKind::Stalled {
                pause_reason: ScheduledPauseReason::Budget,
                ..
            })
        );
        if stalled_on_budget {
            // The workflow's own limit policy owns the switch; the schedule only records what it
            // learned.
            let exhausted = next
                .entries
                .iter()
                .find(|candidate| candidate.id == entry_id)
                .and_then(|candidate| candidate.outcome.as_ref())
                .map(|outcome| outcome.exhausted.clone())
                .unwrap_or_else(|| outcome.exhausted.clone());
            if !exhausted.is_empty() {
                let message = format!(
                    "{} ran out while working on {issue_key}; they will not be started on again.",
                    exhausted.join(", ")
                );
                let last = next.events.iter().rev().find(|event| {
                    event.kind == ScheduledRunEventKind::BudgetChecked
                        && event.entry_id.as_deref() == Some(entry_id)
                });
                if last.is_none_or(|last| last.message != message) {
                    next = self
                        .save(record_budget_check(next, &message, &at, Some(entry_id)))
                        .await?;
                }
            }
            return Ok(next);
        }

        let running = matches!(
            observation
                .as_ref()
                .map(|observation| &observation.progress.kind),
            Some(EntryProgressKind::Running { .. })
        );
        if running && next.status == ScheduledRunStatus::Running {
            let provider = match observation
                .as_ref()
                .map(|observation| &observation.progress.kind)
            {
                Some(EntryProgressKind::Running { provider, .. }) => {
                    provider.clone().or_else(|| outcome.provider.clone())
                }
                _ => outcome.provider.clone(),
            };
            next = self
                .check_handover(next, entry_id, &workflow_run_id, provider)
                .await?;
        }
        Ok(next)
    }
}

impl ScheduledRunRunner {
    /// A schedule paused on a failed entry keeps watching that entry's workflow run. A person can
    /// bring the run back — retry the stage, start a new revision — and finish it; the schedule
    /// used to stop looking at the moment it failed.
    async fn observe_recovered(&self, mut run: ScheduledRun) -> Result<ScheduledRun, String> {
        let paused_for_failure = run.status == ScheduledRunStatus::Paused
            && run.pause.as_ref().map(|pause| pause.reason) == Some(ScheduledPauseReason::Failure);
        if !paused_for_failure {
            return Ok(run);
        }
        let Some(entry_id) = run.pause.as_ref().and_then(|pause| pause.entry_id.clone()) else {
            return Ok(run);
        };
        let Some(entry) = run.entries.iter().find(|entry| entry.id == entry_id) else {
            return Ok(run);
        };
        let issue_key = entry.ticket.issue_key.clone();
        let Some(outcome) = entry.outcome.clone() else {
            return Ok(run);
        };
        if !matches!(
            outcome.status,
            ScheduledEntryStatus::Failed | ScheduledEntryStatus::Paused
        ) {
            return Ok(run);
        }
        let Some(workflow_run_id) = outcome.workflow_run_id.clone() else {
            return Ok(run);
        };
        let mut progress = match self.ports.observe(&workflow_run_id) {
            Some(observation) => observation.progress,
            None => return Ok(run),
        };
        if matches!(progress.kind, EntryProgressKind::Cancelled { .. }) {
            return Ok(run);
        }
        let is_intermediate_sequential_entry = run.policy.mode()
            == ScheduledRunPolicyMode::Sequential
            && run.entries.last().map(|entry| entry.id.as_str()) != Some(entry_id.as_str());

        if let EntryProgressKind::Failed {
            reason, node_id, ..
        } = progress.kind.clone()
        {
            let trust_failure = reason
                .to_lowercase()
                .contains("needs local workspace trust");
            if is_intermediate_sequential_entry
                && trust_failure
                && run.delivery_branch_name.is_some()
                && outcome.retries.unwrap_or(0) <= 1
            {
                let at = self.ports.now();
                let branch = run.delivery_branch_name.clone().unwrap_or_default();
                let retried = retry_scheduled_entry(run, &entry_id, &at)?;
                let message = format!(
                    "{issue_key} is restarting after the workflow trust check was repaired, on {branch}."
                );
                return self
                    .save(record_scheduled_decision(
                        retried,
                        &entry_id,
                        ScheduledRunEventKind::EntryRetried,
                        &at,
                        &message,
                    )?)
                    .await;
            }
            if is_intermediate_sequential_entry && node_id.as_deref() == Some("merge") {
                if let Some(Ok(Some(delivery_branch_name))) = self
                    .ports
                    .delivery_branch_for_workflow(&workflow_run_id)
                    .await
                {
                    let at = self.ports.now();
                    let mut with_branch = run.clone();
                    with_branch.delivery_branch_name = Some(delivery_branch_name.clone());
                    let retried = retry_scheduled_entry(with_branch, &entry_id, &at)?;
                    let message = format!(
                        "{issue_key} merge was deferred to the final ticket; continuing on {delivery_branch_name}."
                    );
                    return self
                        .save(record_scheduled_decision(
                            retried,
                            &entry_id,
                            ScheduledRunEventKind::EntryRetried,
                            &at,
                            &message,
                        )?)
                        .await;
                }
            }
            return Ok(run);
        }

        if let EntryProgressKind::Gate { node_id, label, .. } = progress.kind.clone() {
            let decided = match self.ports.decide_gate(&workflow_run_id, &node_id).await {
                Some(Ok(result)) => {
                    let at = self.ports.now();
                    let message = format!(
                        "{} gate \"{}\": {} — {}",
                        issue_key, label, result.decision, result.reason
                    );
                    run = self
                        .save(record_scheduled_decision(
                            run,
                            &entry_id,
                            ScheduledRunEventKind::GateDecided,
                            &at,
                            &message,
                        )?)
                        .await?;
                    true
                }
                Some(Err(_)) => false,
                None => match self.ports.approve_gate(&workflow_run_id, &node_id).await {
                    Some(Ok(())) => {
                        let at = self.ports.now();
                        let message =
                            format!("{} gate \"{}\": approved autonomously.", issue_key, label);
                        run = self
                            .save(record_scheduled_decision(
                                run,
                                &entry_id,
                                ScheduledRunEventKind::GateDecided,
                                &at,
                                &message,
                            )?)
                            .await?;
                        true
                    }
                    Some(Err(_)) => false,
                    None => false,
                },
            };
            if decided {
                progress = match self.ports.observe(&workflow_run_id) {
                    Some(observation) => observation.progress,
                    None => return Ok(run),
                };
                if matches!(
                    progress.kind,
                    EntryProgressKind::Failed { .. } | EntryProgressKind::Cancelled { .. }
                ) {
                    return Ok(run);
                }
            }
        }

        if let EntryProgressKind::Stalled {
            edge_id, recovery, ..
        } = progress.kind.clone()
        {
            if let Some(edge_id) = edge_id {
                if let Some(Ok(result)) = self.ports.decide_loop(&workflow_run_id, &edge_id).await {
                    let at = self.ports.now();
                    let message = format!(
                        "{} loop decision: {} — {}",
                        issue_key, result.decision, result.reason
                    );
                    run = self
                        .save(record_scheduled_decision(
                            run,
                            &entry_id,
                            ScheduledRunEventKind::LoopDecided,
                            &at,
                            &message,
                        )?)
                        .await?;
                    progress = match self.ports.observe(&workflow_run_id) {
                        Some(observation) => observation.progress,
                        None => return Ok(run),
                    };
                    if matches!(
                        progress.kind,
                        EntryProgressKind::Failed { .. } | EntryProgressKind::Cancelled { .. }
                    ) {
                        return Ok(run);
                    }
                }
            }
            if let Some(recovery) = recovery {
                let automatic = recovery.automatic != Some(false);
                if automatic
                    && recovery.attempts < recovery.max_attempts
                    && self
                        .ports
                        .retry_stage(&workflow_run_id, &recovery.node_id)
                        .await
                        .is_some_and(|result| result.is_ok())
                {
                    let at = self.ports.now();
                    let message = format!(
                        "{} {} recovered automatically after the workflow resumed.",
                        issue_key, recovery.node_id
                    );
                    run = self
                        .save(record_scheduled_decision(
                            run,
                            &entry_id,
                            ScheduledRunEventKind::EntryRetried,
                            &at,
                            &message,
                        )?)
                        .await?;
                    progress = match self.ports.observe(&workflow_run_id) {
                        Some(observation) => observation.progress,
                        None => return Ok(run),
                    };
                    if matches!(
                        progress.kind,
                        EntryProgressKind::Failed { .. } | EntryProgressKind::Cancelled { .. }
                    ) {
                        return Ok(run);
                    }
                }
            }
        }

        if matches!(progress.kind, EntryProgressKind::Succeeded { .. }) {
            run = self
                .move_ticket(run, &entry_id, ScheduledTicketPhase::Done)
                .await?;
        }
        let at = self.ports.now();
        self.save(apply_entry_progress(run, &entry_id, &progress, &at)?)
            .await
    }

    /// Hands the ticket over to another provider when the one it is on is nearly out of allowance.
    async fn check_handover(
        &self,
        run: ScheduledRun,
        entry_id: &str,
        workflow_run_id: &str,
        provider: Option<String>,
    ) -> Result<ScheduledRun, String> {
        let Some(provider) = provider else {
            return Ok(run);
        };
        let Some(entry) = run.entries.iter().find(|entry| entry.id == entry_id) else {
            return Ok(run);
        };
        let handovers = entry
            .outcome
            .as_ref()
            .map(|outcome| outcome.handovers.clone())
            .unwrap_or_default();
        // A hand-over takes effect at the next stage, so the stage in flight still reports the
        // provider it was moved away from. That is the switch waiting to land, not a reason to
        // switch again: repeating it here is how one ticket logged the same hand-over 55 times.
        if let Some(last) = handovers.last() {
            if last.from == provider {
                return Ok(run);
            }
        }
        let usage = self.ports.usage().await?;
        let mut left_behind: Vec<String> = Vec::new();
        for handover in &handovers {
            if !left_behind.contains(&handover.from) {
                left_behind.push(handover.from.clone());
            }
        }
        let exclude = entry
            .outcome
            .as_ref()
            .map(|outcome| outcome.exhausted.clone())
            .unwrap_or_default();
        let decision = decide_provider_for_entry(&ProviderBudgetInput {
            active: Some(&provider),
            usable: &usage.usable,
            used: &usage.used,
            exclude: &exclude,
            left_behind: &left_behind,
            excluded_as_last_resort: false,
            threshold: self.ports.threshold(),
        });
        match decision {
            ProviderDecision::Handover {
                provider: to,
                from: Some(from),
                used_fraction,
                ..
            } => {
                let used_fraction = used_fraction
                    .or(self.ports.threshold())
                    .unwrap_or(DEFAULT_HANDOVER_THRESHOLD);
                let handover = self
                    .ports
                    .hand_over(ScheduledHandOverRequest {
                        run: run.clone(),
                        entry: entry.clone(),
                        workflow_run_id: workflow_run_id.to_string(),
                        from: from.clone(),
                        to: to.clone(),
                        used_fraction,
                    })
                    .await;
                let (checkpoint_ref, to) = match handover {
                    Ok(result) => (result.checkpoint_ref, result.provider.unwrap_or(to)),
                    Err(error) => {
                        let message = format!("Provider handover failed: {error}");
                        let at = self.ports.now();
                        return self
                            .save(pause_scheduled_run(
                                run,
                                ScheduledPauseReason::Budget,
                                &message,
                                &at,
                                Some(entry_id),
                            )?)
                            .await;
                    }
                };
                let at = self.ports.now();
                let record = ScheduledHandover {
                    at: at.clone(),
                    from,
                    to,
                    used_percent: used_fraction * 100.0,
                    checkpoint_ref,
                };
                Ok(self
                    .save(record_provider_handover(run, entry_id, &record, &at)?)
                    .await?)
            }
            ProviderDecision::Pause { reason, .. } => {
                let at = self.ports.now();
                Ok(self
                    .save(pause_scheduled_run(
                        run,
                        ScheduledPauseReason::Budget,
                        &reason,
                        &at,
                        Some(entry_id),
                    )?)
                    .await?)
            }
            ProviderDecision::Ok { .. } | ProviderDecision::Handover { .. } => Ok(run),
        }
    }
}

impl ScheduledRunRunner {
    /// Launches queued tickets into free lanes, skipping any that can no longer run.
    async fn launch_next(&self, start: ScheduledRun) -> Result<(), String> {
        let mut run = start;
        let mut guard = 0;
        while guard <= run.entries.len() {
            guard += 1;
            if run.status != ScheduledRunStatus::Running {
                return Ok(());
            }
            let alongside: Vec<ScheduledQueueEntry> = active_scheduled_entries(&run)
                .into_iter()
                .cloned()
                .collect();
            let Some(entry) = launchable_entries(&run).into_iter().next().cloned() else {
                let at = self.ports.now();
                let before = run.clone();
                let completed = complete_if_drained(run, &at);
                if completed != before {
                    self.save(completed).await?;
                }
                return Ok(());
            };

            if let Some(unavailable) = self.ports.check_ticket(&entry.ticket).await? {
                let at = self.ports.now();
                run = self
                    .save(skip_scheduled_entry(run, &entry.id, &at, &unavailable)?)
                    .await?;
                continue;
            }

            let Some(workflow_id) = run.policy.workflow_id().cloned() else {
                let at = self.ports.now();
                self.save(pause_scheduled_run(
                    run,
                    ScheduledPauseReason::Policy,
                    "No workflow is chosen for this schedule, so no ticket can be started.",
                    &at,
                    Some(&entry.id),
                )?)
                .await?;
                return Ok(());
            };

            let usage = self.ports.usage().await?;
            let mut exclude: Vec<String> = entry
                .outcome
                .as_ref()
                .map(|outcome| outcome.exhausted.clone())
                .unwrap_or_default();
            for provider in exhausted_in_run(&run) {
                if !exclude.contains(&provider) {
                    exclude.push(provider);
                }
            }
            let decision = decide_provider_for_entry(&ProviderBudgetInput {
                active: usage.active.as_deref(),
                usable: &usage.usable,
                used: &usage.used,
                exclude: &exclude,
                left_behind: &[],
                // Starting work is different from moving it mid-ticket: an old limit may have
                // cleared, and refusing to start anything at all is worse than trying the only
                // provider there is.
                excluded_as_last_resort: true,
                threshold: self.ports.threshold(),
            });
            let (provider, reason) = match &decision {
                ProviderDecision::Pause { reason, why } => {
                    // With other tickets still running, the run carries on with them; this one
                    // waits for a free allowance.
                    if !alongside.is_empty() {
                        let message = format!("{} waits: {reason}", entry.ticket.issue_key);
                        self.record_once(run.clone(), &entry.id, &message).await?;
                        return Ok(());
                    }
                    let at = self.ports.now();
                    let pause_reason = if *why == crate::scheduled_budget::PauseWhy::NoProvider {
                        ScheduledPauseReason::NoProvider
                    } else {
                        ScheduledPauseReason::Budget
                    };
                    self.save(pause_scheduled_run(
                        run,
                        pause_reason,
                        reason,
                        &at,
                        Some(&entry.id),
                    )?)
                    .await?;
                    return Ok(());
                }
                ProviderDecision::Ok {
                    provider, reason, ..
                } => (provider.clone(), reason.clone()),
                ProviderDecision::Handover {
                    provider, reason, ..
                } => (provider.clone(), reason.clone()),
            };

            let lane = if scheduled_concurrency(&run.policy) > 1 {
                Some(self.lane_for(
                    &run,
                    &entry.id,
                    &alongside,
                    &provider,
                    usage.used.get(&provider),
                ))
            } else {
                None
            };
            if let Some(lane) = &lane {
                if !lane.ok {
                    let message = format!(
                        "{} waits for a free lane: {}",
                        entry.ticket.issue_key, lane.reason
                    );
                    self.record_once(run.clone(), &entry.id, &message).await?;
                    return Ok(());
                }
            }

            let at = self.ports.now();
            run = self
                .save(record_budget_check(run, &reason, &at, Some(&entry.id)))
                .await?;

            let token = self.ports.new_token();
            let at = self.ports.now();
            let lane_argument = lane.as_ref().map(|lane| ScheduledLane {
                lane: lane.lane,
                reason: lane.reason.clone(),
            });
            run = self
                .save(mark_entry_launching(
                    run,
                    &entry.id,
                    &token,
                    Some(&provider),
                    &at,
                    lane_argument.as_ref(),
                )?)
                .await?;
            self.launching
                .lock()
                .expect("scheduled run launches")
                .insert(entry.id.clone());

            let delivery_branch_name = match run.policy.mode() {
                ScheduledRunPolicyMode::Sequential => Some(
                    run.delivery_branch_name
                        .clone()
                        .unwrap_or_else(|| scheduled_branch_name(&run.id)),
                ),
                ScheduledRunPolicyMode::Parallel => None,
            };
            let final_entry = run.entries.last().map(|last| last.id.as_str()) == Some(&entry.id);
            let launch = self
                .ports
                .launch(ScheduledLaunchRequest {
                    run: run.clone(),
                    entry: entry.clone(),
                    workflow_id: workflow_id.clone(),
                    token: token.clone(),
                    provider: Some(provider.clone()),
                    delivery_branch_name,
                    final_entry,
                })
                .await;

            match launch {
                Ok(launched) => {
                    if let Some(branch) = launched.delivery_branch_name {
                        if run.policy.mode() == ScheduledRunPolicyMode::Sequential {
                            let mut with_branch = run.clone();
                            with_branch.delivery_branch_name = Some(branch);
                            self.save(with_branch).await?;
                        }
                    }
                    let at = self.ports.now();
                    run = self
                        .save(bind_entry_workflow(
                            run,
                            &entry.id,
                            &launched.workflow_run_id,
                            &at,
                        )?)
                        .await?;
                    run = self
                        .move_ticket(run, &entry.id, ScheduledTicketPhase::Indeterminate)
                        .await?;
                }
                Err(error) => {
                    // The launch threw, but it may have got as far as creating the run: only a
                    // missing run is safe to retry.
                    let at = self.ports.now();
                    if let Some(found) = self.ports.find_by_launch_token(&token) {
                        let bound = self
                            .save(bind_entry_workflow(run, &entry.id, &found, &at)?)
                            .await?;
                        self.move_ticket(bound, &entry.id, ScheduledTicketPhase::Indeterminate)
                            .await?;
                    } else {
                        let reason = error.reason.unwrap_or(ScheduledPauseReason::Policy);
                        let message = format!(
                            "{} could not be started: {}",
                            entry.ticket.issue_key, error.message
                        );
                        let requeued = requeue(run, &entry.id);
                        self.save(pause_scheduled_run(
                            requeued,
                            reason,
                            &message,
                            &at,
                            Some(&entry.id),
                        )?)
                        .await?;
                    }
                    self.launching
                        .lock()
                        .expect("scheduled run launches")
                        .remove(&entry.id);
                    return Ok(());
                }
            }
            self.launching
                .lock()
                .expect("scheduled run launches")
                .remove(&entry.id);
            if scheduled_concurrency(&run.policy) == 1 {
                return Ok(());
            }
        }
        Ok(())
    }

    /// The lane a parallel run starts this entry in, and why it may run now. The first ticket going
    /// needs only a free lane; every other one also needs the provider's reported allowance to have
    /// room for all the tickets on it.
    fn lane_for(
        &self,
        run: &ScheduledRun,
        entry_id: &str,
        alongside: &[ScheduledQueueEntry],
        provider: &str,
        used: Option<f64>,
    ) -> LaneChoice {
        let lane = free_scheduled_lane(run);
        let steps = scheduled_steps(&run.entries);
        let step_index = steps
            .iter()
            .position(|step| step.iter().any(|entry| entry.id == entry_id))
            .unwrap_or(0);
        let step_name = format!("step {}", step_index + 1);
        if alongside.is_empty() {
            return LaneChoice {
                ok: true,
                lane,
                reason: format!("first ticket going in {step_name}."),
            };
        }
        let sharing = alongside
            .iter()
            .filter(|candidate| {
                candidate
                    .outcome
                    .as_ref()
                    .and_then(|outcome| outcome.provider.as_deref())
                    == Some(provider)
            })
            .count();
        let extra = decide_extra_lane(&ExtraLaneInput {
            provider,
            used,
            alongside: sharing,
            threshold: self.ports.threshold(),
        });
        let keys = alongside
            .iter()
            .map(|candidate| candidate.ticket.issue_key.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        LaneChoice {
            ok: extra.0,
            lane,
            reason: if extra.0 {
                format!(
                    "runs alongside {keys}; tickets in {step_name} do not depend on each other. {}",
                    extra.1
                )
            } else {
                extra.1
            },
        }
    }

    /// Moves the ticket on its board and notes it in the ledger. Best-effort: a tracker that refuses
    /// is noted too, but never stops the run — the work itself is what the schedule is for.
    async fn move_ticket(
        &self,
        run: ScheduledRun,
        entry_id: &str,
        phase: ScheduledTicketPhase,
    ) -> Result<ScheduledRun, String> {
        let Some(entry) = run.entries.iter().find(|entry| entry.id == entry_id) else {
            return Ok(run);
        };
        let request = ScheduledMoveTicketRequest {
            run: run.clone(),
            entry: entry.clone(),
            phase,
        };
        let Some(result) = self.ports.move_ticket(&request).await else {
            return Ok(run);
        };
        let message = match result {
            Ok(Some(status)) => {
                format!("{} moved to {status} on the board.", entry.ticket.issue_key)
            }
            Ok(None) => return Ok(run),
            Err(error) => format!(
                "{} could not be moved to {} on the board: {error}",
                entry.ticket.issue_key,
                match phase {
                    ScheduledTicketPhase::Done => "done",
                    ScheduledTicketPhase::Indeterminate => "in progress",
                }
            ),
        };
        let at = self.ports.now();
        self.save(record_scheduled_decision(
            run,
            entry_id,
            ScheduledRunEventKind::TicketStatus,
            &at,
            &message,
        )?)
        .await
    }

    /// Notes why a ticket is waiting, once: a tick every half-minute must not fill the ledger with
    /// the same line.
    async fn record_once(
        &self,
        run: ScheduledRun,
        entry_id: &str,
        message: &str,
    ) -> Result<(), String> {
        let last = run.events.iter().rev().find(|event| {
            event.kind == ScheduledRunEventKind::BudgetChecked
                && event.entry_id.as_deref() == Some(entry_id)
        });
        if last.is_some_and(|last| last.message == message) {
            return Ok(());
        }
        let at = self.ports.now();
        self.save(record_budget_check(run, message, &at, Some(entry_id)))
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    use crate::scheduled_budget::ProviderUsage;
    use crate::scheduled_run::{
        CreateScheduledRunInput, ScheduledTicketRef, arm_scheduled_run, create_scheduled_run,
        ticket_ref_key,
    };
    use crate::scheduled_run_store::normalize_scheduled_run;

    const CREATED: &str = "2026-10-20T10:00:00.000Z";
    const START: &str = "2026-10-20T12:00:00.000Z";
    const NOW: &str = "2026-10-20T12:00:01.000Z";

    /// What a launch recorded.
    #[derive(Debug, Clone)]
    struct LaunchRecord {
        key: String,
        provider: Option<String>,
        token: String,
        delivery_branch_name: Option<String>,
        final_entry: bool,
    }

    #[derive(Clone, Default)]
    struct HarnessState {
        saved: HashMap<String, ScheduledRun>,
        workflows: HashMap<String, WorkflowObservation>,
        by_token: HashMap<String, String>,
        launches: Vec<LaunchRecord>,
        cancelled: Vec<String>,
        handovers: Vec<(String, String)>,
        missing_tickets: HashMap<String, String>,
        fail_launch: Option<ScheduledLaunchError>,
        launch_before_failing: bool,
        usage: ProviderUsageReading,
        enabled: bool,
        counter: u32,
        clock: String,
    }

    /// The state the fake host and the test share.
    struct SharedState {
        inner: Mutex<HarnessState>,
    }

    /// The fake host.
    #[derive(Clone)]
    struct Ports {
        state: Arc<SharedState>,
    }

    /// The fake host, from the test's side.
    struct Harness {
        state: Arc<SharedState>,
    }

    impl Harness {
        fn new() -> Self {
            let state = HarnessState {
                enabled: true,
                clock: NOW.to_string(),
                usage: ProviderUsageReading {
                    usable: vec!["claude".into(), "codex".into()],
                    active: Some("claude".into()),
                    used: ProviderUsage::new().with("claude", 0.1).with("codex", 0.1),
                },
                ..HarnessState::default()
            };
            Self {
                state: Arc::new(SharedState {
                    inner: Mutex::new(state),
                }),
            }
        }

        fn ticket(key: &str) -> ScheduledTicketRef {
            ScheduledTicketRef {
                connection_id: "c".into(),
                issue_key: key.into(),
                title: key.into(),
            }
        }

        /// Arms a schedule with the given tickets.
        fn arm(&self, keys: &[&str], workflow_id: Option<&str>) -> String {
            self.arm_with(keys, workflow_id, vec![], None)
        }

        /// Arms a schedule whose tickets share one step.
        fn arm_parallel(&self, keys: &[&str], max_concurrency: i64) -> String {
            let with_previous = keys
                .iter()
                .skip(1)
                .map(|key| ticket_ref_key("c", key))
                .collect();
            self.arm_with(keys, Some("governed"), with_previous, Some(max_concurrency))
        }

        fn arm_with(
            &self,
            keys: &[&str],
            workflow_id: Option<&str>,
            with_previous: Vec<String>,
            max_concurrency: Option<i64>,
        ) -> String {
            let draft = create_scheduled_run(CreateScheduledRunInput {
                id: None,
                project_id: None,
                name: "Night".into(),
                scheduled_start_at: START.into(),
                timezone: "UTC".into(),
                tickets: keys.iter().map(|key| Self::ticket(key)).collect(),
                with_previous,
                workflow_id: workflow_id.map(str::to_string),
                max_concurrency,
                at: CREATED.into(),
            })
            .expect("draft");
            let id = draft.id.clone();
            let armed = arm_scheduled_run(draft, CREATED).expect("arm");
            self.state
                .inner
                .lock()
                .expect("harness")
                .saved
                .insert(id.clone(), armed);
            id
        }

        fn run(&self) -> ScheduledRun {
            self.state
                .inner
                .lock()
                .expect("harness")
                .saved
                .values()
                .next()
                .cloned()
                .expect("run")
        }

        fn status(&self, key: &str) -> Option<ScheduledEntryStatus> {
            self.run()
                .entries
                .iter()
                .find(|entry| entry.ticket.issue_key == key)
                .and_then(|entry| entry.outcome.as_ref())
                .map(|outcome| outcome.status)
        }

        fn launches(&self) -> Vec<LaunchRecord> {
            self.state.inner.lock().expect("harness").launches.clone()
        }

        fn handovers(&self) -> Vec<(String, String)> {
            self.state.inner.lock().expect("harness").handovers.clone()
        }

        /// Sets what the workflow engine says about a ticket's workflow run.
        fn set_workflow(&self, key: &str, observation: Option<WorkflowObservation>) {
            let mut state = self.state.inner.lock().expect("harness");
            match observation {
                Some(observation) => {
                    state.workflows.insert(format!("wf-{key}"), observation);
                }
                None => {
                    state.workflows.remove(&format!("wf-{key}"));
                }
            }
        }

        fn set_usage(&self, usage: ProviderUsageReading) {
            self.state.inner.lock().expect("harness").usage = usage;
        }

        /// Moves the fake clock.
        fn set_clock(&self, clock: &str) {
            self.state.inner.lock().expect("harness").clock = clock.into();
        }

        fn set_enabled(&self, enabled: bool) {
            self.state.inner.lock().expect("harness").enabled = enabled;
        }

        fn set_missing_ticket(&self, key: &str, reason: &str) {
            self.state
                .inner
                .lock()
                .expect("harness")
                .missing_tickets
                .insert(key.into(), reason.into());
        }

        fn set_fail_launch(&self, error: Option<ScheduledLaunchError>, before_failing: bool) {
            let mut state = self.state.inner.lock().expect("harness");
            state.fail_launch = error;
            state.launch_before_failing = before_failing;
        }

        fn runner(&self) -> Arc<ScheduledRunRunner> {
            Arc::new(ScheduledRunRunner::new(Arc::new(Ports {
                state: Arc::clone(&self.state),
            })))
        }
    }

    /// A run whose tickets share a step, so a failed ticket can report what ran out.
    fn exhausted(kind: EntryProgressKind) -> Option<WorkflowObservation> {
        Some(WorkflowObservation {
            progress: EntryProgress {
                kind,
                estimate: None,
                artifacts: vec![],
            },
            idle: None,
        })
    }

    #[tokio::test]
    async fn a_due_run_starts_once_and_launches_only_the_first_ticket() {
        let harness = Harness::new();
        harness.arm(&["T-1", "T-2", "T-3"], Some("governed"));
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Running);
        assert_eq!(harness.run().attempts.len(), 1);
        assert_eq!(
            harness
                .launches()
                .iter()
                .map(|launch| launch.key.clone())
                .collect::<Vec<_>>(),
            vec!["T-1"]
        );
        runner.tick().await;
        assert_eq!(harness.run().attempts.len(), 1);
        assert_eq!(harness.launches().len(), 1);
    }

    #[tokio::test]
    async fn a_run_that_is_not_yet_due_does_not_start() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        harness.set_clock("2026-10-20T11:00:00.000Z");
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Scheduled);
        assert!(harness.launches().is_empty());
    }

    #[tokio::test]
    async fn nothing_runs_while_the_host_disables_execution() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        harness.set_enabled(false);
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Scheduled);
        assert!(harness.launches().is_empty());
    }

    #[tokio::test]
    async fn tickets_run_in_order_each_waiting_for_the_one_before_to_settle() {
        let harness = Harness::new();
        harness.arm(&["T-1", "T-2", "T-3"], Some("governed"));
        let runner = harness.runner();
        runner.tick().await;
        runner.tick().await;
        assert_eq!(harness.launches().len(), 1);

        harness.set_workflow(
            "T-1",
            exhausted(EntryProgressKind::Succeeded {
                spend: None,
                exhausted: vec![],
            }),
        );
        runner.tick().await;
        assert_eq!(harness.status("T-1"), Some(ScheduledEntryStatus::Done));
        assert_eq!(
            harness
                .launches()
                .iter()
                .map(|launch| launch.key.clone())
                .collect::<Vec<_>>(),
            vec!["T-1", "T-2"]
        );

        harness.set_workflow(
            "T-2",
            exhausted(EntryProgressKind::Succeeded {
                spend: None,
                exhausted: vec![],
            }),
        );
        runner.tick().await;
        harness.set_workflow(
            "T-3",
            exhausted(EntryProgressKind::Succeeded {
                spend: None,
                exhausted: vec![],
            }),
        );
        runner.tick().await;

        assert_eq!(harness.run().status, ScheduledRunStatus::Completed);
        let launches = harness.launches();
        assert_eq!(
            launches
                .iter()
                .map(|launch| launch.key.clone())
                .collect::<Vec<_>>(),
            vec!["T-1", "T-2", "T-3"]
        );
        let branches: Vec<&Option<String>> = launches
            .iter()
            .map(|launch| &launch.delivery_branch_name)
            .collect();
        assert!(
            branches.windows(2).all(|pair| pair[0] == pair[1]),
            "sequential tickets share one branch: {branches:?}"
        );
        assert_eq!(
            launches
                .iter()
                .map(|launch| launch.final_entry)
                .collect::<Vec<_>>(),
            vec![false, false, true],
            "only the final entry keeps its merge stage"
        );
        assert!(harness.run().attempts[0].ended_at.is_some());
    }

    #[tokio::test]
    async fn a_gate_pauses_the_run_and_it_carries_on_by_itself_once_the_gate_clears() {
        let harness = Harness::new();
        harness.arm(&["T-1", "T-2"], Some("governed"));
        let runner = harness.runner();
        runner.tick().await;
        harness.set_workflow(
            "T-1",
            exhausted(EntryProgressKind::Gate {
                node_id: "review".into(),
                label: "Review sign-off".into(),
                spend: None,
                exhausted: vec![],
            }),
        );
        runner.tick().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Paused);
        assert_eq!(
            harness.run().pause.as_ref().map(|pause| pause.reason),
            Some(ScheduledPauseReason::Approval)
        );
        assert_eq!(
            harness.run().entries[0]
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.gate.as_ref())
                .map(|gate| gate.label.as_str()),
            Some("Review sign-off")
        );

        runner.tick().await;
        assert_eq!(
            harness.launches().len(),
            1,
            "nothing launches while waiting"
        );
        let error = runner.resume(&harness.run().id).await.expect_err("refused");
        assert!(error.contains("approval gate"), "{error}");

        harness.set_workflow(
            "T-1",
            exhausted(EntryProgressKind::Running {
                provider: Some("claude".into()),
                session_id: None,
                spend: None,
                exhausted: vec![],
            }),
        );
        runner.tick().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Running);
        assert!(
            harness.run().entries[0]
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.gate.as_ref())
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_failure_pauses_and_never_moves_on_by_itself() {
        let harness = Harness::new();
        harness.arm(&["T-1", "T-2"], Some("governed"));
        let runner = harness.runner();
        runner.tick().await;
        harness.set_workflow(
            "T-1",
            exhausted(EntryProgressKind::Failed {
                reason: "the tests failed".into(),
                node_id: None,
                spend: None,
                exhausted: vec![],
            }),
        );
        runner.tick().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Paused);
        assert_eq!(
            harness.run().pause.as_ref().map(|pause| pause.reason),
            Some(ScheduledPauseReason::Failure)
        );
        runner.tick().await;
        assert_eq!(
            harness.launches().len(),
            1,
            "the next ticket does not start"
        );

        let error = runner.resume(&harness.run().id).await.expect_err("refused");
        assert!(error.contains("Retry it, skip it, or stop"), "{error}");

        let entry_id = harness.run().entries[0].id.clone();
        runner
            .retry_entry(&harness.run().id, &entry_id)
            .await
            .expect("retry");
        assert_eq!(
            harness.launches().len(),
            2,
            "the retry launches a fresh run"
        );
        assert_eq!(
            harness.run().entries[0]
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.retries),
            Some(1)
        );
    }

    #[tokio::test]
    async fn a_crash_between_saving_and_launching_never_launches_twice() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        // The workflow run got created, then the process died.
        harness.set_fail_launch(Some(ScheduledLaunchError::plain("process died")), true);
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(
            harness.run().entries[0]
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.workflow_run_id.as_deref()),
            Some("wf-T-1")
        );
        assert_eq!(harness.launches().len(), 1, "it launched once");
        assert_eq!(harness.launches()[0].token, "token-1");
    }

    #[tokio::test]
    async fn a_crash_before_the_workflow_run_existed_pauses_as_launch_interrupted() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        let runner = harness.runner();
        runner.tick().await;

        // Simulate the restart: the saved entry is running with a token and no workflow id.
        let mut run = harness.run();
        if let Some(outcome) = run.entries[0].outcome.as_mut() {
            outcome.workflow_run_id = None;
        }
        let id = run.id.clone();
        harness
            .state
            .inner
            .lock()
            .expect("harness")
            .saved
            .insert(id.clone(), run);
        harness
            .state
            .inner
            .lock()
            .expect("harness")
            .by_token
            .clear();
        harness
            .state
            .inner
            .lock()
            .expect("harness")
            .launches
            .clear();

        runner.recover().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Paused);
        assert_eq!(
            harness.run().pause.as_ref().map(|pause| pause.reason),
            Some(ScheduledPauseReason::LaunchInterrupted)
        );
        runner.tick().await;
        assert!(
            harness.launches().is_empty(),
            "it never relaunches by itself"
        );

        let entry_id = harness.run().entries[0].id.clone();
        runner.retry_entry(&id, &entry_id).await.expect("retry");
        assert_eq!(harness.launches().len(), 1);
    }

    #[tokio::test]
    async fn a_launch_that_throws_before_creating_anything_pauses_and_requeues_the_ticket() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        harness.set_fail_launch(
            Some(ScheduledLaunchError::with_reason(
                "This workflow needs trust.",
                ScheduledPauseReason::Trust,
            )),
            false,
        );
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Paused);
        assert_eq!(
            harness.run().pause.as_ref().map(|pause| pause.reason),
            Some(ScheduledPauseReason::Trust)
        );
        assert_eq!(harness.status("T-1"), Some(ScheduledEntryStatus::Queued));

        harness.set_fail_launch(None, false);
        runner.resume(&harness.run().id).await.expect("resume");
        assert_eq!(harness.launches().len(), 1);
        assert_eq!(harness.run().status, ScheduledRunStatus::Running);
    }

    #[tokio::test]
    async fn a_deleted_ticket_is_skipped_with_a_readable_reason_and_the_next_one_starts() {
        let harness = Harness::new();
        harness.arm(&["T-1", "T-2"], Some("governed"));
        harness.set_missing_ticket("T-1", "T-1 no longer exists.");
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(harness.status("T-1"), Some(ScheduledEntryStatus::Skipped));
        assert_eq!(
            harness.run().entries[0]
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.reason.as_deref()),
            Some("T-1 no longer exists.")
        );
        assert_eq!(
            harness
                .launches()
                .iter()
                .map(|launch| launch.key.clone())
                .collect::<Vec<_>>(),
            vec!["T-2"]
        );
    }

    #[tokio::test]
    async fn a_schedule_with_no_workflow_pauses_instead_of_guessing_one() {
        let harness = Harness::new();
        harness.arm(&["T-1"], None);
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Paused);
        assert_eq!(
            harness.run().pause.as_ref().map(|pause| pause.reason),
            Some(ScheduledPauseReason::Policy)
        );
        assert!(harness.launches().is_empty());
    }

    #[tokio::test]
    async fn budget_starts_on_a_provider_under_the_threshold_and_switches_away_from_one_at_the_limit()
     {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        harness.set_usage(ProviderUsageReading {
            usable: vec!["claude".into(), "codex".into()],
            active: Some("claude".into()),
            used: ProviderUsage::new().with("claude", 0.96).with("codex", 0.2),
        });
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(
            harness.launches()[0].provider.as_deref(),
            Some("codex"),
            "a provider at the limit is not started on"
        );
    }

    #[tokio::test]
    async fn budget_with_no_provider_under_the_limit_pauses_and_launches_nothing() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        harness.set_usage(ProviderUsageReading {
            usable: vec!["claude".into()],
            active: Some("claude".into()),
            used: ProviderUsage::new().with("claude", 0.97),
        });
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Paused);
        assert_eq!(
            harness.run().pause.as_ref().map(|pause| pause.reason),
            Some(ScheduledPauseReason::Budget)
        );
        assert!(harness.launches().is_empty());
    }

    #[tokio::test]
    async fn a_provider_that_reports_nothing_is_used_rather_than_stopping_the_run() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        harness.set_usage(ProviderUsageReading {
            usable: vec!["claude".into(), "copilot".into()],
            active: Some("claude".into()),
            used: ProviderUsage::new().with("claude", 0.97),
        });
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(harness.run().status, ScheduledRunStatus::Running);
        assert_eq!(harness.launches()[0].provider.as_deref(), Some("copilot"));
    }

    #[tokio::test]
    async fn a_mid_ticket_hand_over_records_the_checkpoint_and_the_switch() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        let runner = harness.runner();
        runner.tick().await;
        harness.set_usage(ProviderUsageReading {
            usable: vec!["claude".into(), "codex".into()],
            active: Some("claude".into()),
            used: ProviderUsage::new().with("claude", 0.95).with("codex", 0.3),
        });
        runner.tick().await;
        assert_eq!(
            harness.handovers(),
            vec![("claude".to_string(), "codex".to_string())]
        );
        let outcome = harness.run().entries[0].outcome.clone().expect("outcome");
        let handover = outcome.handovers.first().expect("handover");
        assert_eq!(handover.checkpoint_ref.as_deref(), Some("abc1234"));
        assert_eq!(handover.used_percent, 95.0);
        assert_eq!(outcome.provider.as_deref(), Some("codex"));
    }

    #[tokio::test]
    async fn a_mid_ticket_hand_over_never_goes_back_to_the_provider_that_already_ran_out() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        let runner = harness.runner();
        runner.tick().await;
        // Claude ran out, the workflow's own switch policy moved the stage to codex, and codex is
        // nearly spent.
        harness.set_workflow(
            "T-1",
            exhausted(EntryProgressKind::Running {
                provider: Some("codex".into()),
                session_id: None,
                spend: None,
                exhausted: vec!["claude".into()],
            }),
        );
        harness.set_usage(ProviderUsageReading {
            usable: vec!["claude".into(), "codex".into(), "copilot".into()],
            active: Some("claude".into()),
            used: ProviderUsage::new().with("claude", 0.1).with("codex", 0.96),
        });
        runner.tick().await;
        assert_eq!(
            harness.handovers(),
            vec![("codex".to_string(), "copilot".to_string())]
        );
    }

    #[tokio::test]
    async fn a_retry_does_not_go_back_to_the_provider_that_ran_out() {
        let harness = Harness::new();
        harness.arm(&["T-1", "T-2"], Some("governed"));
        let runner = harness.runner();
        runner.tick().await;
        assert_eq!(harness.launches()[0].provider.as_deref(), Some("claude"));

        harness.set_workflow(
            "T-1",
            exhausted(EntryProgressKind::Failed {
                reason: "claude-code-cli ran out of credits".into(),
                node_id: None,
                spend: None,
                exhausted: vec!["claude".into()],
            }),
        );
        runner.tick().await;
        assert_eq!(
            harness.run().entries[0]
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.exhausted.first())
                .cloned(),
            Some("claude".to_string())
        );

        let entry_id = harness.run().entries[0].id.clone();
        runner
            .retry_entry(&harness.run().id, &entry_id)
            .await
            .expect("retry");
        let launches = harness.launches();
        assert_eq!(
            launches[1].provider.as_deref(),
            Some("codex"),
            "the retry starts elsewhere"
        );
        assert_eq!(
            harness.run().entries[0]
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.exhausted.first())
                .cloned(),
            Some("claude".to_string()),
            "and remembers it after relaunching"
        );
    }

    #[tokio::test]
    async fn a_workflow_run_that_vanished_fails_its_ticket_for_the_user_to_decide() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        let runner = harness.runner();
        runner.tick().await;
        harness.set_workflow("T-1", None);
        runner.tick().await;
        assert_eq!(harness.status("T-1"), Some(ScheduledEntryStatus::Failed));
        assert_eq!(harness.run().status, ScheduledRunStatus::Paused);
    }

    #[tokio::test]
    async fn stopping_a_run_stops_every_ticket_in_flight() {
        let harness = Harness::new();
        harness.arm_parallel(&["A", "B"], 2);
        let runner = harness.runner();
        runner.tick().await;
        let run = runner.cancel(&harness.run().id).await.expect("cancel");
        assert_eq!(run.status, ScheduledRunStatus::Cancelled);
        let cancelled = harness
            .state
            .inner
            .lock()
            .expect("harness")
            .cancelled
            .clone();
        assert_eq!(cancelled, vec!["wf-A".to_string(), "wf-B".to_string()]);
    }

    #[tokio::test]
    async fn run_now_starts_a_future_schedule_immediately() {
        let harness = Harness::new();
        harness.arm(&["T-1"], Some("governed"));
        harness.set_clock("2026-10-19T09:00:00.000Z");
        let runner = harness.runner();
        let run = runner
            .start_now(&harness.run().id)
            .await
            .expect("start now");
        assert_eq!(run.status, ScheduledRunStatus::Running);
        assert_eq!(
            run.attempts[0].trigger,
            crate::scheduled_run::ScheduledRunTrigger::StartNow
        );
        assert_eq!(harness.launches().len(), 1);
    }

    #[tokio::test]
    async fn a_parallel_run_starts_two_lanes_at_once_and_waits_for_a_free_one() {
        let harness = Harness::new();
        harness.arm_parallel(&["A", "B", "C"], 2);
        let runner = harness.runner();
        runner.tick().await;
        let launched: Vec<String> = harness
            .launches()
            .iter()
            .map(|launch| launch.key.clone())
            .collect();
        assert_eq!(launched, vec!["A", "B"], "two lanes, not three");
        assert_eq!(
            harness.run().entries[0]
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.lane),
            Some(1)
        );
        assert_eq!(
            harness.run().entries[1]
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.lane),
            Some(2)
        );
    }

    #[async_trait]
    impl ScheduledRunnerPorts for Ports {
        async fn list(&self) -> Vec<ScheduledRun> {
            self.state
                .inner
                .lock()
                .expect("harness")
                .saved
                .values()
                .cloned()
                .collect()
        }

        fn get(&self, id: &str) -> Option<ScheduledRun> {
            self.state
                .inner
                .lock()
                .expect("harness")
                .saved
                .get(id)
                .cloned()
        }

        async fn save(&self, run: ScheduledRun) -> Result<ScheduledRun, String> {
            let mut state = self.state.inner.lock().expect("harness");
            // Round-trip through the normaliser like the real store, so a field the store drops
            // shows up here.
            let stored = serde_json::to_value(&run)
                .ok()
                .and_then(|value| normalize_scheduled_run(&value))
                .unwrap_or(run);
            state.saved.insert(stored.id.clone(), stored.clone());
            Ok(stored)
        }

        fn now(&self) -> String {
            self.state.inner.lock().expect("harness").clock.clone()
        }

        fn is_enabled(&self) -> bool {
            self.state.inner.lock().expect("harness").enabled
        }

        fn new_token(&self) -> String {
            let mut state = self.state.inner.lock().expect("harness");
            state.counter += 1;
            format!("token-{}", state.counter)
        }

        fn observe(&self, workflow_run_id: &str) -> Option<WorkflowObservation> {
            self.state
                .inner
                .lock()
                .expect("harness")
                .workflows
                .get(workflow_run_id)
                .cloned()
        }

        fn find_by_launch_token(&self, token: &str) -> Option<String> {
            self.state
                .inner
                .lock()
                .expect("harness")
                .by_token
                .get(token)
                .cloned()
        }

        async fn check_ticket(
            &self,
            ticket: &ScheduledTicketRef,
        ) -> Result<Option<String>, String> {
            Ok(self
                .state
                .inner
                .lock()
                .expect("harness")
                .missing_tickets
                .get(&ticket.issue_key)
                .cloned())
        }

        async fn launch(
            &self,
            request: ScheduledLaunchRequest,
        ) -> Result<ScheduledLaunched, ScheduledLaunchError> {
            let mut state = self.state.inner.lock().expect("harness");
            let failure = state.fail_launch.clone();
            if let Some(failure) = &failure {
                if !state.launch_before_failing {
                    return Err(failure.clone());
                }
            }
            let id = format!("wf-{}", request.entry.ticket.issue_key);
            state.launches.push(LaunchRecord {
                key: request.entry.ticket.issue_key.clone(),
                provider: request.provider.clone(),
                token: request.token.clone(),
                delivery_branch_name: request.delivery_branch_name.clone(),
                final_entry: request.final_entry,
            });
            state.by_token.insert(request.token.clone(), id.clone());
            state.workflows.insert(
                id.clone(),
                WorkflowObservation {
                    progress: EntryProgress::running(request.provider.as_deref()),
                    idle: None,
                },
            );
            if let Some(failure) = failure {
                return Err(failure);
            }
            Ok(ScheduledLaunched {
                workflow_run_id: id,
                delivery_branch_name: request.delivery_branch_name.clone(),
            })
        }

        async fn cancel_workflow(
            &self,
            workflow_run_id: &str,
            _reason: &str,
        ) -> Result<(), String> {
            self.state
                .inner
                .lock()
                .expect("harness")
                .cancelled
                .push(workflow_run_id.to_string());
            Ok(())
        }

        async fn usage(&self) -> Result<ProviderUsageReading, String> {
            Ok(self.state.inner.lock().expect("harness").usage.clone())
        }

        async fn hand_over(
            &self,
            request: ScheduledHandOverRequest,
        ) -> Result<ScheduledHandOverResult, String> {
            self.state
                .inner
                .lock()
                .expect("harness")
                .handovers
                .push((request.from.clone(), request.to.clone()));
            Ok(ScheduledHandOverResult {
                checkpoint_ref: Some("abc1234".into()),
                provider: None,
            })
        }
    }
}
