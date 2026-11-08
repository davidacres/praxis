//! What happens to a scheduled run once it starts: the pure transitions the runner applies
//! (`scheduledRunExecution.ts` port).
//!
//! Same rules as the definition operations — no clock reads, no I/O, each takes the time it happened
//! at — so restart recovery, ordering and "never launch the same ticket twice" are tested here
//! without a workflow engine. An operation that changes nothing returns the very same run, which is
//! how the runner knows not to save.
//!
//! Order is strict. A sequential run launches only the first queued entry, and only while no other
//! entry is running, paused or failed. A parallel run may overlap the entries of one step, up to its
//! cap, and a step still waits for every entry before it. Either way a failure never lets the run
//! move past it by itself.

use indexmap::IndexMap;

use crate::scheduled_run::{
    EventDraft, ScheduledEntryDecision, ScheduledEntryEstimate, ScheduledEntryGate,
    ScheduledEntryOutcome, ScheduledEntrySpend, ScheduledEntryStatus, ScheduledHandover,
    ScheduledPauseReason, ScheduledQueueEntry, ScheduledRun, ScheduledRunAttempt,
    ScheduledRunEventKind, ScheduledRunPause, ScheduledRunStatus, ScheduledRunTrigger,
    new_scheduled_id, scheduled_concurrency, scheduled_steps, status_word, touch,
};
use crate::types::WorkflowArtifactRef;

/// What a stage may be recovered to after a stall.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageRecovery {
    pub node_id: String,
    pub attempts: u32,
    pub max_attempts: u32,
    /// Whether the recovery is automatic, rather than the user's call.
    pub automatic: Option<bool>,
}

/// What the workflow engine says about an entry's workflow run, reduced to what the schedule acts
/// on. `exhausted` lists the providers that ran out during the run, so a retry or a hand-over never
/// goes back to one of them.
#[derive(Debug, Clone, PartialEq)]
pub enum EntryProgressKind {
    Running {
        provider: Option<String>,
        session_id: Option<String>,
        spend: Option<ScheduledEntrySpend>,
        exhausted: Vec<String>,
    },
    Gate {
        node_id: String,
        label: String,
        spend: Option<ScheduledEntrySpend>,
        exhausted: Vec<String>,
    },
    /// Stopped on the provider's limit or a stage's tooling; waiting for the user.
    Stalled {
        reason: String,
        pause_reason: ScheduledPauseReason,
        edge_id: Option<String>,
        recovery: Option<StageRecovery>,
        spend: Option<ScheduledEntrySpend>,
        exhausted: Vec<String>,
    },
    Succeeded {
        spend: Option<ScheduledEntrySpend>,
        exhausted: Vec<String>,
    },
    Failed {
        reason: String,
        node_id: Option<String>,
        spend: Option<ScheduledEntrySpend>,
        exhausted: Vec<String>,
    },
    Cancelled {
        reason: String,
        spend: Option<ScheduledEntrySpend>,
        exhausted: Vec<String>,
    },
}

/// One observation of an entry's workflow run.
#[derive(Debug, Clone, PartialEq)]
pub struct EntryProgress {
    pub kind: EntryProgressKind,
    pub estimate: Option<ScheduledEntryEstimate>,
    pub artifacts: Vec<WorkflowArtifactRef>,
}

impl EntryProgress {
    /// An observation that only says the workflow run is going.
    #[must_use]
    pub fn running(provider: Option<&str>) -> Self {
        Self {
            kind: EntryProgressKind::Running {
                provider: provider.map(str::to_string),
                session_id: None,
                spend: None,
                exhausted: Vec::new(),
            },
            estimate: None,
            artifacts: Vec::new(),
        }
    }

    /// The spend the observation reported, if any.
    fn spend(&self) -> Option<&ScheduledEntrySpend> {
        match &self.kind {
            EntryProgressKind::Running { spend, .. }
            | EntryProgressKind::Gate { spend, .. }
            | EntryProgressKind::Stalled { spend, .. }
            | EntryProgressKind::Succeeded { spend, .. }
            | EntryProgressKind::Failed { spend, .. }
            | EntryProgressKind::Cancelled { spend, .. } => spend.as_ref(),
        }
    }

    /// The providers that ran out during the workflow run, as reported by this observation.
    fn exhausted(&self) -> &[String] {
        match &self.kind {
            EntryProgressKind::Running { exhausted, .. }
            | EntryProgressKind::Gate { exhausted, .. }
            | EntryProgressKind::Stalled { exhausted, .. }
            | EntryProgressKind::Succeeded { exhausted, .. }
            | EntryProgressKind::Failed { exhausted, .. }
            | EntryProgressKind::Cancelled { exhausted, .. } => exhausted,
        }
    }
}

/// The lane an entry started in, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledLane {
    pub lane: u32,
    pub reason: String,
}

/// The entry currently occupying the run: running or paused (a failed entry blocks, but is not
/// "active").
#[must_use]
pub fn active_scheduled_entry(run: &ScheduledRun) -> Option<&ScheduledQueueEntry> {
    run.entries.iter().find(|entry| is_active(entry))
}

/// The first entry that failed.
#[must_use]
pub fn failed_scheduled_entry(run: &ScheduledRun) -> Option<&ScheduledQueueEntry> {
    run.entries
        .iter()
        .find(|entry| status_of(entry) == ScheduledEntryStatus::Failed)
}

/// Every entry occupying a lane: running, or paused at a gate or a stall.
#[must_use]
pub fn active_scheduled_entries(run: &ScheduledRun) -> Vec<&ScheduledQueueEntry> {
    run.entries
        .iter()
        .filter(|entry| is_active(entry))
        .collect()
}

fn is_active(entry: &ScheduledQueueEntry) -> bool {
    matches!(
        status_of(entry),
        ScheduledEntryStatus::Running | ScheduledEntryStatus::Paused
    )
}

fn status_of(entry: &ScheduledQueueEntry) -> ScheduledEntryStatus {
    entry
        .outcome
        .as_ref()
        .map(|outcome| outcome.status)
        .unwrap_or(ScheduledEntryStatus::Queued)
}

fn outcome_of(entry: &ScheduledQueueEntry) -> ScheduledEntryOutcome {
    entry
        .outcome
        .clone()
        .unwrap_or_else(ScheduledEntryOutcome::queued)
}

fn finished(entry: &ScheduledQueueEntry) -> bool {
    matches!(
        status_of(entry),
        ScheduledEntryStatus::Done | ScheduledEntryStatus::Skipped
    )
}

/// The entries that may launch now, in order, with no more than there are free lanes. Nothing
/// launches unless the run is running and no entry has failed.
///
/// Sequential: the first queued entry, and only when nothing else is active.
/// Parallel: queued entries of the *current step* — the first step with anything unfinished — so a
/// step waits for every entry before it (the join bar), and entries of one step overlap only up to
/// `maxConcurrency`.
#[must_use]
pub fn launchable_entries(run: &ScheduledRun) -> Vec<&ScheduledQueueEntry> {
    if run.status != ScheduledRunStatus::Running {
        return Vec::new();
    }
    if run
        .entries
        .iter()
        .any(|entry| status_of(entry) == ScheduledEntryStatus::Failed)
    {
        return Vec::new();
    }
    let active = active_scheduled_entries(run).len();
    let cap = scheduled_concurrency(&run.policy);
    if cap == 1 {
        let first = if active == 0 {
            run.entries
                .iter()
                .find(|entry| status_of(entry) == ScheduledEntryStatus::Queued)
        } else {
            None
        };
        return first.into_iter().collect();
    }
    let Some(current) = scheduled_steps(&run.entries)
        .into_iter()
        .find(|step| step.iter().any(|entry| !finished(entry)))
    else {
        return Vec::new();
    };
    current
        .into_iter()
        .filter(|entry| status_of(entry) == ScheduledEntryStatus::Queued)
        .take(cap.saturating_sub(active as u32) as usize)
        .collect()
}

/// The next entry to launch, or `None` when none may (see [`launchable_entries`]).
#[must_use]
pub fn next_launchable_entry(run: &ScheduledRun) -> Option<&ScheduledQueueEntry> {
    launchable_entries(run).into_iter().next()
}

/// The lowest lane number no active entry holds.
#[must_use]
pub fn free_scheduled_lane(run: &ScheduledRun) -> u32 {
    let taken: Vec<u32> = active_scheduled_entries(run)
        .into_iter()
        .filter_map(|entry| entry.outcome.as_ref().and_then(|outcome| outcome.lane))
        .collect();
    let mut lane = 1;
    while taken.contains(&lane) {
        lane += 1;
    }
    lane
}

/// The entry that still needs a person, if any, and why: a failure first, then a gate, then a stall.
/// With several lanes more than one entry can be waiting, but a run holds one pause, so when one is
/// settled the pause moves to the next.
#[derive(Debug, Clone, PartialEq, Eq)]
struct WaitingEntry {
    entry_id: String,
    reason: ScheduledPauseReason,
    message: String,
}

fn waiting_entry(run: &ScheduledRun) -> Option<WaitingEntry> {
    if let Some(failed) = run
        .entries
        .iter()
        .find(|entry| status_of(entry) == ScheduledEntryStatus::Failed)
    {
        let key = &failed.ticket.issue_key;
        let reason = failed
            .outcome
            .as_ref()
            .and_then(|outcome| outcome.reason.clone())
            .unwrap_or_else(|| "it stopped.".to_string());
        return Some(WaitingEntry {
            entry_id: failed.id.clone(),
            reason: ScheduledPauseReason::Failure,
            message: format!("{key} failed: {reason}"),
        });
    }
    if let Some(gated) = run.entries.iter().find(|entry| {
        status_of(entry) == ScheduledEntryStatus::Paused
            && entry
                .outcome
                .as_ref()
                .is_some_and(|outcome| outcome.gate.is_some())
    }) {
        let key = &gated.ticket.issue_key;
        let message = gated
            .outcome
            .as_ref()
            .and_then(|outcome| outcome.reason.clone())
            .unwrap_or_else(|| format!("{key} is waiting for approval."));
        return Some(WaitingEntry {
            entry_id: gated.id.clone(),
            reason: ScheduledPauseReason::Approval,
            message,
        });
    }
    if let Some(stalled) = run
        .entries
        .iter()
        .find(|entry| status_of(entry) == ScheduledEntryStatus::Paused)
    {
        let key = &stalled.ticket.issue_key;
        let outcome = stalled.outcome.as_ref();
        let reason = outcome
            .and_then(|outcome| outcome.wait_reason)
            .unwrap_or(ScheduledPauseReason::Policy);
        let message = outcome
            .and_then(|outcome| outcome.reason.clone())
            .unwrap_or_else(|| format!("{key} is waiting."));
        return Some(WaitingEntry {
            entry_id: stalled.id.clone(),
            reason,
            message,
        });
    }
    None
}

fn paused_run(
    mut run: ScheduledRun,
    reason: ScheduledPauseReason,
    message: &str,
    at: &str,
    entry_id: Option<&str>,
) -> ScheduledRun {
    run.status = ScheduledRunStatus::Paused;
    run.pause = Some(ScheduledRunPause {
        reason,
        entry_id: entry_id.map(str::to_string),
        message: message.to_string(),
        at: at.to_string(),
    });
    run
}

fn running_again(mut run: ScheduledRun) -> ScheduledRun {
    run.pause = None;
    run.status = ScheduledRunStatus::Running;
    run
}

/// Takes the run off pause, unless another entry is still waiting for a person; then the pause moves
/// to it.
fn resume_unless_waiting(run: ScheduledRun, at: &str, resumed: Option<EventDraft>) -> ScheduledRun {
    if let Some(other) = waiting_entry(&run) {
        if run
            .pause
            .as_ref()
            .and_then(|pause| pause.entry_id.as_deref())
            == Some(&other.entry_id)
            && run.status == ScheduledRunStatus::Paused
        {
            return touch(run, at, resumed);
        }
        let paused = paused_run(run, other.reason, &other.message, at, Some(&other.entry_id));
        return touch(
            paused,
            at,
            Some(EventDraft {
                kind: ScheduledRunEventKind::Paused,
                message: other.message.clone(),
                entry_id: Some(other.entry_id.clone()),
            }),
        );
    }
    touch(running_again(run), at, resumed)
}

/// Finds one entry, or says the ticket is not in this schedule.
fn find_entry<'a>(
    run: &'a ScheduledRun,
    entry_id: &str,
) -> Result<&'a ScheduledQueueEntry, String> {
    run.entries
        .iter()
        .find(|entry| entry.id == entry_id)
        .ok_or_else(|| "That ticket is not in this schedule.".to_string())
}

/// Replaces one entry's outcome.
fn with_outcome(
    mut run: ScheduledRun,
    entry_id: &str,
    outcome: Option<ScheduledEntryOutcome>,
) -> ScheduledRun {
    for entry in &mut run.entries {
        if entry.id == entry_id {
            entry.outcome = outcome;
            break;
        }
    }
    run
}

/// The providers known to have run out, merging what the run reports with what was already recorded.
fn exhausted_after(outcome: &ScheduledEntryOutcome, reported: &[String]) -> Option<Vec<String>> {
    let mut merged: Vec<String> = Vec::new();
    for provider in outcome.exhausted.iter().chain(reported.iter()) {
        if !merged.contains(provider) {
            merged.push(provider.clone());
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

/// Whether the providers recorded against an outcome are the ones a new observation reported. An
/// entry that recorded none is the same as an observation that reported none.
fn exhausted_matches(stored: &[String], computed: &Option<Vec<String>>) -> bool {
    match computed {
        None => stored.is_empty(),
        Some(list) => stored == list,
    }
}

/// Closes the last attempt that is still open.
fn close_last_attempt(run: &mut ScheduledRun, at: &str) {
    if let Some(attempt) = run.attempts.last_mut() {
        if attempt.ended_at.is_none() {
            attempt.ended_at = Some(at.to_string());
        }
    }
}

/// Starts an armed run. The trigger records an explicit Run now decision.
pub fn start_scheduled_run_attempt(run: ScheduledRun, at: &str) -> Result<ScheduledRun, String> {
    if run.status != ScheduledRunStatus::Scheduled {
        return Err(format!(
            "A {} run cannot be started.",
            status_word(run.status)
        ));
    }
    let last_decision = run
        .events
        .iter()
        .rev()
        .find(|event| {
            event.kind == ScheduledRunEventKind::StartNow
                || event.kind == ScheduledRunEventKind::Armed
        })
        .map(|event| event.kind);
    let trigger = if last_decision == Some(ScheduledRunEventKind::StartNow) {
        ScheduledRunTrigger::StartNow
    } else {
        ScheduledRunTrigger::Schedule
    };
    let attempt = ScheduledRunAttempt {
        id: new_scheduled_id("attempt"),
        trigger,
        started_at: at.to_string(),
        ended_at: None,
    };
    let mut next = run;
    next.status = ScheduledRunStatus::Running;
    next.attempts.push(attempt);
    let message = match trigger {
        ScheduledRunTrigger::StartNow => "Started at the user’s request.",
        ScheduledRunTrigger::Schedule => "Started on schedule.",
    };
    Ok(touch(
        next,
        at,
        Some(EventDraft {
            kind: ScheduledRunEventKind::Started,
            message: message.to_string(),
            entry_id: None,
        }),
    ))
}

/// Records, before anything is launched, that this entry is about to be. Saving this first is what
/// makes a crash between "decided to launch" and "launched" recoverable without launching twice.
pub fn mark_entry_launching(
    run: ScheduledRun,
    entry_id: &str,
    launch_token: &str,
    provider: Option<&str>,
    at: &str,
    lane: Option<&ScheduledLane>,
) -> Result<ScheduledRun, String> {
    let entry = find_entry(&run, entry_id)?;
    let previous = outcome_of(entry);
    if previous.status != ScheduledEntryStatus::Queued {
        return Err(format!("{} is not waiting to run.", entry.ticket.issue_key));
    }
    let mut next = ScheduledEntryOutcome {
        status: ScheduledEntryStatus::Running,
        launch_token: Some(launch_token.to_string()),
        started_at: Some(at.to_string()),
        provider: provider.map(str::to_string),
        estimate: previous.estimate.clone(),
        artifacts: previous.artifacts.clone(),
        retries: previous.retries,
        handovers: previous.handovers.clone(),
        exhausted: previous.exhausted.clone(),
        ..ScheduledEntryOutcome::queued()
    };
    if let Some(lane) = lane {
        next.lane = Some(lane.lane);
        next.lane_reason = Some(lane.reason.clone());
    }

    let message = format!(
        "Starting {}{}{}",
        entry.ticket.issue_key,
        provider.map_or(String::new(), |provider| format!(" on {provider}")),
        lane.map_or_else(
            || ".".to_string(),
            |lane| format!(" in lane {}: {}", lane.lane, lane.reason)
        )
    );
    let next = with_outcome(run, entry_id, Some(next));
    Ok(touch(
        next,
        at,
        Some(EventDraft {
            kind: ScheduledRunEventKind::EntryLaunching,
            message,
            entry_id: Some(entry_id.to_string()),
        }),
    ))
}

/// Ties the entry to the workflow run that was launched for it.
pub fn bind_entry_workflow(
    run: ScheduledRun,
    entry_id: &str,
    workflow_run_id: &str,
    at: &str,
) -> Result<ScheduledRun, String> {
    let entry = find_entry(&run, entry_id)?;
    let mut outcome = outcome_of(entry);
    if outcome.workflow_run_id.as_deref() == Some(workflow_run_id) {
        return Ok(run);
    }
    outcome.workflow_run_id = Some(workflow_run_id.to_string());
    let key = entry.ticket.issue_key.clone();
    let next = with_outcome(run, entry_id, Some(outcome));
    Ok(touch(
        next,
        at,
        Some(EventDraft {
            kind: ScheduledRunEventKind::EntryStarted,
            message: format!("{key} is running."),
            entry_id: Some(entry_id.to_string()),
        }),
    ))
}

/// Applies what the workflow run is doing to the entry (and, when it needs a person, to the run).
/// Idempotent: repeating the same progress changes nothing.
pub fn apply_entry_progress(
    run: ScheduledRun,
    entry_id: &str,
    progress: &EntryProgress,
    at: &str,
) -> Result<ScheduledRun, String> {
    let outcome = outcome_of(find_entry(&run, entry_id)?);
    if matches!(
        outcome.status,
        ScheduledEntryStatus::Done | ScheduledEntryStatus::Skipped
    ) {
        return Ok(run);
    }
    let estimate = outcome
        .estimate
        .clone()
        .or_else(|| progress.estimate.clone());
    let artifacts = merge_artifacts(&outcome.artifacts, &progress.artifacts);
    let changed = estimate != outcome.estimate || artifacts != outcome.artifacts;
    let enriched = if changed {
        let mut next = outcome.clone();
        if estimate.is_some() {
            next.estimate = estimate.clone();
        }
        if !artifacts.is_empty() {
            next.artifacts = artifacts.clone();
        }
        with_outcome(run, entry_id, Some(next))
    } else {
        run
    };
    apply_progress_state(enriched, entry_id, progress, at)
}

/// Merges artifacts by id, the newer winning, keeping the order they were first seen in.
fn merge_artifacts(
    previous: &[WorkflowArtifactRef],
    reported: &[WorkflowArtifactRef],
) -> Vec<WorkflowArtifactRef> {
    let mut merged: IndexMap<String, WorkflowArtifactRef> = IndexMap::new();
    for artifact in previous.iter().chain(reported.iter()) {
        merged.insert(artifact.artifact_id.clone(), artifact.clone());
    }
    merged.into_values().collect()
}

fn apply_progress_state(
    run: ScheduledRun,
    entry_id: &str,
    progress: &EntryProgress,
    at: &str,
) -> Result<ScheduledRun, String> {
    let entry = find_entry(&run, entry_id)?;
    let outcome = outcome_of(entry);
    if matches!(
        outcome.status,
        ScheduledEntryStatus::Done | ScheduledEntryStatus::Skipped
    ) {
        return Ok(run);
    }
    let key = entry.ticket.issue_key.clone();
    let spend = progress.spend().cloned().or_else(|| outcome.spend.clone());
    let exhausted = exhausted_after(&outcome, progress.exhausted());
    let without_gate = ScheduledEntryOutcome {
        gate: None,
        reason: None,
        wait_reason: None,
        ..outcome.clone()
    };

    match &progress.kind {
        EntryProgressKind::Running {
            provider,
            session_id,
            ..
        } => {
            let paused_for_this_entry = run.status == ScheduledRunStatus::Paused
                && run
                    .pause
                    .as_ref()
                    .and_then(|pause| pause.entry_id.as_deref())
                    == Some(entry_id);
            let was_waiting = paused_for_this_entry
                && match run.pause.as_ref().map(|pause| pause.reason) {
                    Some(ScheduledPauseReason::Approval)
                    | Some(ScheduledPauseReason::Policy)
                    | Some(ScheduledPauseReason::Failure) => true,
                    Some(ScheduledPauseReason::Budget) => {
                        outcome.status == ScheduledEntryStatus::Paused
                    }
                    _ => false,
                };
            let unchanged = outcome.status == ScheduledEntryStatus::Running
                && outcome.gate.is_none()
                && !was_waiting
                && outcome.spend == spend
                && exhausted_matches(&outcome.exhausted, &exhausted)
                && provider
                    .as_ref()
                    .is_none_or(|provider| Some(provider) == outcome.provider.as_ref())
                && session_id
                    .as_ref()
                    .is_none_or(|session_id| Some(session_id) == outcome.session_id.as_ref());
            if unchanged {
                return Ok(run);
            }
            let mut next = without_gate;
            next.status = ScheduledEntryStatus::Running;
            if let Some(provider) = provider {
                next.provider = Some(provider.clone());
            }
            if let Some(session_id) = session_id {
                next.session_id = Some(session_id.clone());
            }
            if spend.is_some() {
                next.spend = spend.clone();
            }
            if exhausted.is_some() {
                next.exhausted = exhausted.clone().unwrap_or_default();
            }
            let next = with_outcome(run, entry_id, Some(next));
            if was_waiting {
                Ok(resume_unless_waiting(
                    next,
                    at,
                    Some(EventDraft {
                        kind: ScheduledRunEventKind::Resumed,
                        message: format!("{key} is running again."),
                        entry_id: Some(entry_id.to_string()),
                    }),
                ))
            } else {
                Ok(touch(next, at, None))
            }
        }
        EntryProgressKind::Gate { node_id, label, .. } => {
            let same_gate = outcome
                .gate
                .as_ref()
                .is_some_and(|gate| gate.node_id == *node_id);
            if outcome.status == ScheduledEntryStatus::Paused && same_gate && outcome.spend == spend
            {
                return Ok(run);
            }
            let gate = ScheduledEntryGate {
                node_id: node_id.clone(),
                label: label.clone(),
                since: if same_gate {
                    outcome
                        .gate
                        .as_ref()
                        .map(|gate| gate.since.clone())
                        .unwrap_or_else(|| at.to_string())
                } else {
                    at.to_string()
                },
            };
            let message = format!("{key} is waiting for approval: {label}.");
            let mut next = outcome.clone();
            next.status = ScheduledEntryStatus::Paused;
            next.gate = Some(gate);
            next.reason = Some(message.clone());
            if spend.is_some() {
                next.spend = spend.clone();
            }
            if exhausted.is_some() {
                next.exhausted = exhausted.clone().unwrap_or_default();
            }
            let next = with_outcome(run, entry_id, Some(next));
            if same_gate {
                Ok(touch(next, at, None))
            } else {
                let paused = paused_run(
                    next,
                    ScheduledPauseReason::Approval,
                    &message,
                    at,
                    Some(entry_id),
                );
                Ok(touch(
                    paused,
                    at,
                    Some(EventDraft {
                        kind: ScheduledRunEventKind::EntryGate,
                        message,
                        entry_id: Some(entry_id.to_string()),
                    }),
                ))
            }
        }
        EntryProgressKind::Stalled {
            reason,
            pause_reason,
            ..
        } => {
            if outcome.status == ScheduledEntryStatus::Paused
                && outcome.reason.as_deref() == Some(reason.as_str())
                && run.status == ScheduledRunStatus::Paused
                && exhausted_matches(&outcome.exhausted, &exhausted)
            {
                return Ok(run);
            }
            let mut next = without_gate;
            next.status = ScheduledEntryStatus::Paused;
            next.reason = Some(reason.clone());
            next.wait_reason = Some(*pause_reason);
            if spend.is_some() {
                next.spend = spend.clone();
            }
            if exhausted.is_some() {
                next.exhausted = exhausted.clone().unwrap_or_default();
            }
            let next = with_outcome(run, entry_id, Some(next));
            let paused = paused_run(next, *pause_reason, reason, at, Some(entry_id));
            Ok(touch(
                paused,
                at,
                Some(EventDraft {
                    kind: ScheduledRunEventKind::Paused,
                    message: reason.clone(),
                    entry_id: Some(entry_id.to_string()),
                }),
            ))
        }
        EntryProgressKind::Succeeded { .. } => {
            let mut next = without_gate;
            next.status = ScheduledEntryStatus::Done;
            next.ended_at = Some(at.to_string());
            if spend.is_some() {
                next.spend = spend.clone();
            }
            if exhausted.is_some() {
                next.exhausted = exhausted.clone().unwrap_or_default();
            }
            let settled_for_this_entry = run.status == ScheduledRunStatus::Paused
                && run
                    .pause
                    .as_ref()
                    .and_then(|pause| pause.entry_id.as_deref())
                    == Some(entry_id);
            let next = with_outcome(run, entry_id, Some(next));
            let done = EventDraft {
                kind: ScheduledRunEventKind::EntryDone,
                message: format!("{key} finished."),
                entry_id: Some(entry_id.to_string()),
            };
            let settled = if settled_for_this_entry {
                resume_unless_waiting(next, at, Some(done))
            } else {
                touch(next, at, Some(done))
            };
            Ok(complete_if_drained(settled, at))
        }
        EntryProgressKind::Failed { reason, .. } => {
            let message = format!("{key} failed: {reason}");
            let mut next = without_gate;
            next.status = ScheduledEntryStatus::Failed;
            next.ended_at = Some(at.to_string());
            next.reason = Some(reason.clone());
            if spend.is_some() {
                next.spend = spend.clone();
            }
            if exhausted.is_some() {
                next.exhausted = exhausted.clone().unwrap_or_default();
            }
            let next = with_outcome(run, entry_id, Some(next));
            let paused = paused_run(
                next,
                ScheduledPauseReason::Failure,
                &message,
                at,
                Some(entry_id),
            );
            Ok(touch(
                paused,
                at,
                Some(EventDraft {
                    kind: ScheduledRunEventKind::EntryFailed,
                    message,
                    entry_id: Some(entry_id.to_string()),
                }),
            ))
        }
        EntryProgressKind::Cancelled { reason, .. } => {
            let message = format!("{key} was cancelled: {reason}");
            let mut next = without_gate;
            next.status = ScheduledEntryStatus::Failed;
            next.ended_at = Some(at.to_string());
            next.reason = Some(reason.clone());
            if spend.is_some() {
                next.spend = spend.clone();
            }
            if exhausted.is_some() {
                next.exhausted = exhausted.clone().unwrap_or_default();
            }
            let next = with_outcome(run, entry_id, Some(next));
            let paused = paused_run(
                next,
                ScheduledPauseReason::Failure,
                &message,
                at,
                Some(entry_id),
            );
            Ok(touch(
                paused,
                at,
                Some(EventDraft {
                    kind: ScheduledRunEventKind::EntryFailed,
                    message,
                    entry_id: Some(entry_id.to_string()),
                }),
            ))
        }
    }
}

/// Notes a provider switch made mid-ticket, with the checkpoint that preserved the work.
pub fn record_provider_handover(
    run: ScheduledRun,
    entry_id: &str,
    handover: &ScheduledHandover,
    at: &str,
) -> Result<ScheduledRun, String> {
    let entry = find_entry(&run, entry_id)?;
    let mut outcome = outcome_of(entry);
    outcome.provider = Some(handover.to.clone());
    outcome.handovers.push(handover.clone());
    let key = entry.ticket.issue_key.clone();
    let next = with_outcome(run, entry_id, Some(outcome));
    let mut message = format!(
        "{key}: {} → {} at {}%",
        handover.from,
        handover.to,
        handover.used_percent.round()
    );
    if let Some(checkpoint) = &handover.checkpoint_ref {
        message.push_str(&format!(", checkpoint {checkpoint}"));
    }
    message.push('.');
    Ok(touch(
        next,
        at,
        Some(EventDraft {
            kind: ScheduledRunEventKind::ProviderHandover,
            message,
            entry_id: Some(entry_id.to_string()),
        }),
    ))
}

/// Records what a budget check decided, for the ledger. Does not change the run's state.
#[must_use]
pub fn record_budget_check(
    run: ScheduledRun,
    message: &str,
    at: &str,
    entry_id: Option<&str>,
) -> ScheduledRun {
    touch(
        run,
        at,
        Some(EventDraft {
            kind: ScheduledRunEventKind::BudgetChecked,
            message: message.to_string(),
            entry_id: entry_id.map(str::to_string),
        }),
    )
}

/// Records an autonomous decision (gate or loop) on the entry and ledger. Does not pause the run.
pub fn record_scheduled_decision(
    run: ScheduledRun,
    entry_id: &str,
    kind: ScheduledRunEventKind,
    at: &str,
    message: &str,
) -> Result<ScheduledRun, String> {
    let entry = find_entry(&run, entry_id)?;
    let mut outcome = outcome_of(entry);
    outcome.decisions.push(ScheduledEntryDecision {
        at: at.to_string(),
        kind,
        message: message.to_string(),
    });
    let next = with_outcome(run, entry_id, Some(outcome));
    Ok(touch(
        next,
        at,
        Some(EventDraft {
            kind,
            message: message.to_string(),
            entry_id: Some(entry_id.to_string()),
        }),
    ))
}

/// Puts a failed, stalled or interrupted ticket back at the front of the queue and lets the run
/// continue.
pub fn retry_scheduled_entry(
    run: ScheduledRun,
    entry_id: &str,
    at: &str,
) -> Result<ScheduledRun, String> {
    let entry = find_entry(&run, entry_id)?;
    let outcome = outcome_of(entry);
    let interrupted =
        outcome.status == ScheduledEntryStatus::Running && outcome.workflow_run_id.is_none();
    if !matches!(
        outcome.status,
        ScheduledEntryStatus::Failed | ScheduledEntryStatus::Paused
    ) && !interrupted
    {
        return Err(format!(
            "{} is not stopped, so there is nothing to retry.",
            entry.ticket.issue_key
        ));
    }
    let next = ScheduledEntryOutcome {
        status: ScheduledEntryStatus::Queued,
        retries: Some(outcome.retries.unwrap_or(0) + 1),
        estimate: outcome.estimate.clone(),
        artifacts: outcome.artifacts.clone(),
        handovers: outcome.handovers.clone(),
        exhausted: outcome.exhausted.clone(),
        ..ScheduledEntryOutcome::queued()
    };
    let key = entry.ticket.issue_key.clone();
    let was_paused = run.status == ScheduledRunStatus::Paused;
    let next = with_outcome(run, entry_id, Some(next));
    let retried = EventDraft {
        kind: ScheduledRunEventKind::EntryRetried,
        message: format!("Retrying {key}."),
        entry_id: Some(entry_id.to_string()),
    };
    if was_paused {
        Ok(resume_unless_waiting(next, at, Some(retried)))
    } else {
        Ok(touch(next, at, Some(retried)))
    }
}

/// Leaves a ticket out of this run; the run carries on with the next one.
pub fn skip_scheduled_entry(
    run: ScheduledRun,
    entry_id: &str,
    at: &str,
    reason: &str,
) -> Result<ScheduledRun, String> {
    let entry = find_entry(&run, entry_id)?;
    let outcome = outcome_of(entry);
    if matches!(
        outcome.status,
        ScheduledEntryStatus::Done | ScheduledEntryStatus::Skipped
    ) {
        return Ok(run);
    }
    let mut next = outcome.clone();
    next.gate = None;
    next.wait_reason = None;
    next.status = ScheduledEntryStatus::Skipped;
    next.ended_at = Some(at.to_string());
    next.reason = Some(reason.to_string());
    let key = entry.ticket.issue_key.clone();
    let settled_for_this_entry = run.status == ScheduledRunStatus::Paused
        && run
            .pause
            .as_ref()
            .and_then(|pause| pause.entry_id.as_deref())
            == Some(entry_id);
    let next = with_outcome(run, entry_id, Some(next));
    let skipped = EventDraft {
        kind: ScheduledRunEventKind::EntrySkipped,
        message: format!("Skipped {key}: {reason}"),
        entry_id: Some(entry_id.to_string()),
    };
    let settled = if settled_for_this_entry {
        resume_unless_waiting(next, at, Some(skipped))
    } else {
        touch(next, at, Some(skipped))
    };
    Ok(complete_if_drained(settled, at))
}

/// A run whose every ticket is done or skipped is complete.
#[must_use]
pub fn complete_if_drained(run: ScheduledRun, at: &str) -> ScheduledRun {
    if run.status != ScheduledRunStatus::Running {
        return run;
    }
    if run.entries.iter().any(|entry| !finished(entry)) {
        return run;
    }
    let mut next = run;
    close_last_attempt(&mut next, at);
    next.status = ScheduledRunStatus::Completed;
    let done = next
        .entries
        .iter()
        .filter(|entry| status_of(entry) == ScheduledEntryStatus::Done)
        .count();
    let message = format!(
        "Finished: {done} of {} ticket{} done.",
        next.entries.len(),
        if next.entries.len() == 1 { "" } else { "s" }
    );
    touch(
        next,
        at,
        Some(EventDraft {
            kind: ScheduledRunEventKind::Completed,
            message,
            entry_id: None,
        }),
    )
}

/// Ends a running or paused run. Stopping after a failure leaves the run `failed`; any other stop is
/// `cancelled`. Tickets that never started are marked skipped.
pub fn cancel_scheduled_run(
    run: ScheduledRun,
    at: &str,
    reason: &str,
) -> Result<ScheduledRun, String> {
    if !matches!(
        run.status,
        ScheduledRunStatus::Running | ScheduledRunStatus::Paused
    ) {
        return Err(format!(
            "A {} run cannot be stopped.",
            status_word(run.status)
        ));
    }
    let failed = run.status == ScheduledRunStatus::Paused
        && run.pause.as_ref().map(|pause| pause.reason) == Some(ScheduledPauseReason::Failure);
    let mut next = run;
    for entry in &mut next.entries {
        let outcome = outcome_of(entry);
        match outcome.status {
            ScheduledEntryStatus::Queued => {
                let mut skipped = outcome;
                skipped.status = ScheduledEntryStatus::Skipped;
                skipped.ended_at = Some(at.to_string());
                skipped.reason = Some(reason.to_string());
                entry.outcome = Some(skipped);
            }
            ScheduledEntryStatus::Running | ScheduledEntryStatus::Paused => {
                let mut stopped = outcome;
                stopped.gate = None;
                stopped.status = ScheduledEntryStatus::Failed;
                stopped.ended_at = Some(at.to_string());
                stopped.reason = Some(reason.to_string());
                entry.outcome = Some(stopped);
            }
            _ => {}
        }
    }
    close_last_attempt(&mut next, at);
    next.pause = None;
    next.status = if failed {
        ScheduledRunStatus::Failed
    } else {
        ScheduledRunStatus::Cancelled
    };
    let message = if failed {
        format!("Stopped after a failure. {reason}")
    } else {
        reason.to_string()
    };
    Ok(touch(
        next,
        at,
        Some(EventDraft {
            kind: ScheduledRunEventKind::Cancelled,
            message,
            entry_id: None,
        }),
    ))
}

/// Pauses the run (not the workflow already in flight) until the user decides.
pub fn pause_scheduled_run(
    run: ScheduledRun,
    reason: ScheduledPauseReason,
    message: &str,
    at: &str,
    entry_id: Option<&str>,
) -> Result<ScheduledRun, String> {
    if run.status != ScheduledRunStatus::Running {
        if run.status == ScheduledRunStatus::Paused {
            return Ok(run);
        }
        return Err(format!(
            "A {} run cannot be paused.",
            status_word(run.status)
        ));
    }
    let paused = paused_run(run, reason, message, at, entry_id);
    Ok(touch(
        paused,
        at,
        Some(EventDraft {
            kind: ScheduledRunEventKind::Paused,
            message: message.to_string(),
            entry_id: entry_id.map(str::to_string),
        }),
    ))
}

/// The user's go-ahead after a pause. A pause caused by a failed ticket needs a decision about that
/// ticket (retry, skip or stop) rather than a bare resume.
pub fn resume_scheduled_run(run: ScheduledRun, at: &str) -> Result<ScheduledRun, String> {
    if run.status != ScheduledRunStatus::Paused {
        return Err("Only a paused run can be resumed.".into());
    }
    match run.pause.as_ref().map(|pause| pause.reason) {
        Some(ScheduledPauseReason::Failure) => {
            Err("A ticket failed. Retry it, skip it, or stop the run.".into())
        }
        Some(ScheduledPauseReason::Approval) => Err(
            "A ticket is waiting at an approval gate. Approve it and the run continues by itself."
                .into(),
        ),
        Some(ScheduledPauseReason::LaunchInterrupted) => {
            Err("Praxis stopped while starting a ticket. Retry it or skip it.".into())
        }
        _ => Ok(touch(
            running_again(run),
            at,
            Some(EventDraft {
                kind: ScheduledRunEventKind::Resumed,
                message: "Resumed.".to_string(),
                entry_id: None,
            }),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::scheduled_run::{
        CreateScheduledRunInput, ScheduledEntryEstimate, ScheduledTicketRef, arm_scheduled_run,
        create_scheduled_run, ticket_ref_key,
    };
    use crate::types::{WorkflowArtifactKind, WorkflowArtifactRef};

    const NOW: &str = "2026-10-20T10:00:00.000Z";
    const LATER: &str = "2026-10-21T21:00:00.000Z";

    fn ticket(key: &str) -> ScheduledTicketRef {
        ScheduledTicketRef {
            connection_id: "c1".into(),
            issue_key: key.into(),
            title: format!("Title {key}"),
        }
    }

    fn draft(keys: &[&str]) -> ScheduledRun {
        create_scheduled_run(CreateScheduledRunInput {
            id: None,
            project_id: None,
            name: "Nightly".into(),
            scheduled_start_at: LATER.into(),
            timezone: "Europe/London".into(),
            tickets: keys.iter().map(|key| ticket(key)).collect(),
            with_previous: vec![],
            workflow_id: Some("governed-delivery".into()),
            max_concurrency: None,
            at: NOW.into(),
        })
        .expect("draft")
    }

    /// A draft whose first step holds every ticket, with `max_concurrency` lanes.
    fn parallel_draft(keys: &[&str], max_concurrency: i64) -> ScheduledRun {
        let with_previous = keys
            .iter()
            .skip(1)
            .map(|key| ticket_ref_key("c1", key))
            .collect();
        create_scheduled_run(CreateScheduledRunInput {
            id: None,
            project_id: None,
            name: "Nightly".into(),
            scheduled_start_at: LATER.into(),
            timezone: "Europe/London".into(),
            tickets: keys.iter().map(|key| ticket(key)).collect(),
            with_previous,
            workflow_id: Some("governed-delivery".into()),
            max_concurrency: Some(max_concurrency),
            at: NOW.into(),
        })
        .expect("draft")
    }

    /// A run that has started, with its first entry marked as launching.
    fn started(keys: &[&str]) -> ScheduledRun {
        let armed = arm_scheduled_run(draft(keys), NOW).expect("arm");
        start_scheduled_run_attempt(armed, NOW).expect("start")
    }

    fn entry_id(run: &ScheduledRun, key: &str) -> String {
        run.entries
            .iter()
            .find(|entry| entry.ticket.issue_key == key)
            .expect("entry")
            .id
            .clone()
    }

    fn outcome(run: &ScheduledRun, key: &str) -> ScheduledEntryOutcome {
        run.entries
            .iter()
            .find(|entry| entry.ticket.issue_key == key)
            .expect("entry")
            .outcome
            .clone()
            .unwrap_or_else(ScheduledEntryOutcome::queued)
    }

    fn artifact(id: &str) -> WorkflowArtifactRef {
        WorkflowArtifactRef {
            artifact_id: id.into(),
            contract_id: "change-diff".into(),
            node_id: "implement".into(),
            run_id: "w".into(),
            kind: WorkflowArtifactKind::Diff,
            path: Some(".praxis/change-diff.md".into()),
            reference: None,
            created_at: NOW.into(),
        }
    }

    fn estimate() -> ScheduledEntryEstimate {
        ScheduledEntryEstimate {
            tokens: Some(crate::scheduled_run::EstimateRange {
                low: 10.0,
                high: 100.0,
            }),
            spend: Some(crate::scheduled_run::EstimateSpendRange {
                low: 1.0,
                high: 2.0,
                currency: "USD".into(),
            }),
            not_estimable: None,
            based_on_sessions: Some(3.0),
        }
    }

    #[test]
    fn a_sequential_run_launches_only_its_first_queued_entry() {
        let run = started(&["PRX-1", "PRX-2"]);
        let launchable = launchable_entries(&run);
        assert_eq!(launchable.len(), 1);
        assert_eq!(launchable[0].ticket.issue_key, "PRX-1");

        let id = entry_id(&run, "PRX-1");
        let running =
            mark_entry_launching(run, &id, "token-1", Some("claude"), NOW, None).expect("launch");
        assert_eq!(active_scheduled_entries(&running).len(), 1);
        assert!(launchable_entries(&running).is_empty());
        assert_eq!(next_launchable_entry(&running), None);
    }

    #[test]
    fn nothing_launches_while_a_ticket_has_failed() {
        let run = started(&["PRX-1", "PRX-2"]);
        let id = entry_id(&run, "PRX-1");
        let launched = mark_entry_launching(run, &id, "token-1", None, NOW, None).expect("launch");
        let failed = apply_entry_progress(
            launched,
            &id,
            &EntryProgress {
                kind: EntryProgressKind::Failed {
                    reason: "the tests failed".into(),
                    node_id: None,
                    spend: None,
                    exhausted: vec![],
                },
                estimate: None,
                artifacts: vec![],
            },
            NOW,
        )
        .expect("fail");
        assert!(launchable_entries(&failed).is_empty());
        assert_eq!(failed.status, ScheduledRunStatus::Paused);
        assert_eq!(
            failed.pause.as_ref().map(|pause| pause.reason),
            Some(ScheduledPauseReason::Failure)
        );
    }

    #[test]
    fn a_parallel_run_launches_the_queued_entries_of_its_current_step_up_to_the_cap() {
        let run = started_parallel(&["A", "B", "C"], 2);
        let launchable = launchable_entries(&run);
        assert_eq!(
            launchable
                .iter()
                .map(|entry| entry.ticket.issue_key.as_str())
                .collect::<Vec<_>>(),
            vec!["A", "B"]
        );

        let id = entry_id(&run, "A");
        let running = mark_entry_launching(run, &id, "token-1", None, NOW, None).expect("launch");
        let launchable = launchable_entries(&running);
        assert_eq!(
            launchable
                .iter()
                .map(|entry| entry.ticket.issue_key.as_str())
                .collect::<Vec<_>>(),
            vec!["B"]
        );
    }

    fn started_parallel(keys: &[&str], max_concurrency: i64) -> ScheduledRun {
        let armed = arm_scheduled_run(parallel_draft(keys, max_concurrency), NOW).expect("arm");
        start_scheduled_run_attempt(armed, NOW).expect("start")
    }

    #[test]
    fn lane_numbers_reuse_the_lowest_free_lane() {
        let run = parallel_draft(&["A", "B", "C"], 3);
        let with_lanes = |lanes: [Option<u32>; 3]| {
            let mut run = run.clone();
            for (index, lane) in lanes.iter().enumerate() {
                if let Some(lane) = lane {
                    let mut outcome = ScheduledEntryOutcome::queued();
                    outcome.status = ScheduledEntryStatus::Running;
                    outcome.lane = Some(*lane);
                    run.entries[index].outcome = Some(outcome);
                }
            }
            run
        };
        assert_eq!(free_scheduled_lane(&with_lanes([None, None, None])), 1);
        assert_eq!(free_scheduled_lane(&with_lanes([Some(2), None, None])), 1);
        assert_eq!(
            free_scheduled_lane(&with_lanes([Some(1), Some(3), None])),
            2
        );
        assert!(
            launchable_entries(&run).is_empty(),
            "a draft launches nothing"
        );
    }

    #[test]
    fn an_entry_that_is_not_queued_cannot_be_launched() {
        let run = started(&["PRX-1"]);
        let id = entry_id(&run, "PRX-1");
        let launched = mark_entry_launching(run, &id, "token-1", None, NOW, None).expect("launch");
        let error =
            mark_entry_launching(launched, &id, "token-2", None, NOW, None).expect_err("refused");
        assert!(error.contains("is not waiting to run"), "{error}");
    }

    #[test]
    fn only_a_scheduled_run_can_start() {
        let draft = draft(&["PRX-1"]);
        let error = start_scheduled_run_attempt(draft, NOW).expect_err("refused");
        assert!(error.contains("cannot be started"), "{error}");
    }

    #[test]
    fn a_run_now_start_records_the_trigger_it_was_given() {
        let armed = arm_scheduled_run(draft(&["PRX-1"]), NOW).expect("arm");
        let run = start_scheduled_run_attempt(armed, NOW).expect("start");
        assert_eq!(run.status, ScheduledRunStatus::Running);
        assert_eq!(run.attempts.len(), 1);
        assert_eq!(run.attempts[0].trigger, ScheduledRunTrigger::Schedule);
        assert_eq!(run.attempts[0].started_at, NOW);
    }

    #[test]
    fn the_ledger_keeps_the_estimate_and_the_artifacts_across_progress() {
        let run = started(&["PRX-1"]);
        let id = entry_id(&run, "PRX-1");
        let launched =
            mark_entry_launching(run, &id, "token-1", Some("claude"), NOW, None).expect("launch");
        let with_ledger = apply_entry_progress(
            launched,
            &id,
            &EntryProgress {
                kind: EntryProgressKind::Running {
                    provider: Some("claude".into()),
                    session_id: None,
                    spend: None,
                    exhausted: vec![],
                },
                estimate: Some(estimate()),
                artifacts: vec![artifact("a")],
            },
            NOW,
        )
        .expect("progress");
        let done = apply_entry_progress(
            with_ledger,
            &id,
            &EntryProgress {
                kind: EntryProgressKind::Succeeded {
                    spend: Some(ScheduledEntrySpend {
                        tokens: Some(50.0),
                        ..ScheduledEntrySpend::default()
                    }),
                    exhausted: vec![],
                },
                estimate: None,
                artifacts: vec![],
            },
            NOW,
        )
        .expect("succeeded");

        let outcome = outcome(&done, "PRX-1");
        assert_eq!(outcome.estimate, Some(estimate()));
        assert_eq!(outcome.artifacts, vec![artifact("a")]);
        assert_eq!(outcome.spend.map(|spend| spend.tokens), Some(Some(50.0)));
        assert_eq!(done.status, ScheduledRunStatus::Completed);
    }

    #[test]
    fn repeating_the_same_progress_changes_nothing() {
        let run = started(&["PRX-1"]);
        let id = entry_id(&run, "PRX-1");
        let launched =
            mark_entry_launching(run, &id, "token-1", Some("claude"), NOW, None).expect("launch");
        let progress = EntryProgress::running(Some("claude"));
        let once = apply_entry_progress(launched.clone(), &id, &progress, NOW).expect("progress");
        let twice = apply_entry_progress(once.clone(), &id, &progress, NOW).expect("progress");
        assert_eq!(once, twice);
    }

    #[test]
    fn a_ticket_waiting_at_a_gate_pauses_the_run_for_approval() {
        let run = started(&["PRX-1"]);
        let id = entry_id(&run, "PRX-1");
        let launched = mark_entry_launching(run, &id, "token-1", None, NOW, None).expect("launch");
        let gated = apply_entry_progress(
            launched,
            &id,
            &EntryProgress {
                kind: EntryProgressKind::Gate {
                    node_id: "node-1".into(),
                    label: "Human review".into(),
                    spend: None,
                    exhausted: vec![],
                },
                estimate: None,
                artifacts: vec![],
            },
            NOW,
        )
        .expect("gate");
        assert_eq!(gated.status, ScheduledRunStatus::Paused);
        assert_eq!(
            gated.pause.as_ref().map(|pause| pause.reason),
            Some(ScheduledPauseReason::Approval)
        );
        let outcome = outcome(&gated, "PRX-1");
        assert_eq!(outcome.status, ScheduledEntryStatus::Paused);
        assert_eq!(
            outcome.gate.as_ref().map(|gate| gate.node_id.as_str()),
            Some("node-1")
        );
        assert!(
            outcome
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("is waiting for approval"))
        );
    }

    #[test]
    fn a_failed_ticket_can_be_retried_and_then_skipped() {
        let run = started(&["PRX-1", "PRX-2"]);
        let id = entry_id(&run, "PRX-1");
        let launched = mark_entry_launching(run, &id, "token-1", None, NOW, None).expect("launch");
        let failed = apply_entry_progress(
            launched,
            &id,
            &EntryProgress {
                kind: EntryProgressKind::Failed {
                    reason: "the tests failed".into(),
                    node_id: None,
                    spend: None,
                    exhausted: vec![],
                },
                estimate: None,
                artifacts: vec![],
            },
            NOW,
        )
        .expect("fail");
        assert_eq!(
            failed.pause.as_ref().map(|pause| pause.reason),
            Some(ScheduledPauseReason::Failure)
        );

        let retried = retry_scheduled_entry(failed, &id, NOW).expect("retry");
        assert_eq!(
            outcome(&retried, "PRX-1").status,
            ScheduledEntryStatus::Queued
        );
        assert_eq!(outcome(&retried, "PRX-1").retries, Some(1));
        assert_eq!(retried.status, ScheduledRunStatus::Running);

        let skipped = skip_scheduled_entry(retried, &id, NOW, "not needed").expect("skip");
        assert_eq!(
            outcome(&skipped, "PRX-1").status,
            ScheduledEntryStatus::Skipped
        );
        assert_eq!(skipped.status, ScheduledRunStatus::Running);
    }

    #[test]
    fn a_pause_for_a_failure_cannot_be_resumed_bare() {
        let run = started(&["PRX-1"]);
        let id = entry_id(&run, "PRX-1");
        let launched = mark_entry_launching(run, &id, "token-1", None, NOW, None).expect("launch");
        let failed = apply_entry_progress(
            launched,
            &id,
            &EntryProgress {
                kind: EntryProgressKind::Failed {
                    reason: "the tests failed".into(),
                    node_id: None,
                    spend: None,
                    exhausted: vec![],
                },
                estimate: None,
                artifacts: vec![],
            },
            NOW,
        )
        .expect("fail");
        let error = resume_scheduled_run(failed, NOW).expect_err("refused");
        assert!(error.contains("A ticket failed"), "{error}");
    }

    #[test]
    fn stopping_a_run_cancels_it_and_skips_what_never_started() {
        let run = started(&["PRX-1", "PRX-2"]);
        let id = entry_id(&run, "PRX-1");
        let launched = mark_entry_launching(run, &id, "token-1", None, NOW, None).expect("launch");
        let cancelled =
            cancel_scheduled_run(launched, NOW, "Stopped by the user.").expect("cancel");
        assert_eq!(cancelled.status, ScheduledRunStatus::Cancelled);
        assert_eq!(
            outcome(&cancelled, "PRX-1").status,
            ScheduledEntryStatus::Failed
        );
        assert_eq!(
            outcome(&cancelled, "PRX-2").status,
            ScheduledEntryStatus::Skipped
        );
        assert!(
            cancelled
                .attempts
                .last()
                .expect("attempt")
                .ended_at
                .is_some()
        );
    }

    #[test]
    fn stopping_after_a_failure_leaves_the_run_failed() {
        let run = started(&["PRX-1"]);
        let id = entry_id(&run, "PRX-1");
        let launched = mark_entry_launching(run, &id, "token-1", None, NOW, None).expect("launch");
        let failed = apply_entry_progress(
            launched,
            &id,
            &EntryProgress {
                kind: EntryProgressKind::Failed {
                    reason: "the tests failed".into(),
                    node_id: None,
                    spend: None,
                    exhausted: vec![],
                },
                estimate: None,
                artifacts: vec![],
            },
            NOW,
        )
        .expect("fail");
        let stopped = cancel_scheduled_run(failed, NOW, "Stopped by the user.").expect("cancel");
        assert_eq!(stopped.status, ScheduledRunStatus::Failed);
    }

    #[test]
    fn a_provider_hand_over_is_recorded_with_its_checkpoint() {
        let run = started(&["PRX-1"]);
        let id = entry_id(&run, "PRX-1");
        let launched =
            mark_entry_launching(run, &id, "token-1", Some("claude"), NOW, None).expect("launch");
        let handover = ScheduledHandover {
            at: NOW.into(),
            from: "claude".into(),
            to: "codex".into(),
            used_percent: 95.0,
            checkpoint_ref: Some("cp-1".into()),
        };
        let handed = record_provider_handover(launched, &id, &handover, NOW).expect("handover");
        let outcome = outcome(&handed, "PRX-1");
        assert_eq!(outcome.provider.as_deref(), Some("codex"));
        assert_eq!(outcome.handovers, vec![handover]);
        let event = handed.events.last().expect("event");
        assert_eq!(event.kind, ScheduledRunEventKind::ProviderHandover);
        assert!(
            event.message.contains("claude → codex at 95%"),
            "{}",
            event.message
        );
        assert!(
            event.message.contains("checkpoint cp-1"),
            "{}",
            event.message
        );
    }
}
