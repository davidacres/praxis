//! Scheduled ticket runs: the durable definition and its pure operations (`scheduledRun.ts` port).
//!
//! A `ScheduledRun` is a definition: a name, one absolute start instant, and an ordered queue of
//! board tickets. What happens when it starts is recorded separately, in `attempts` and in each
//! entry's `outcome`. Everything here is side-effect free. No clock reads, no I/O. Every
//! operation takes the time it happened at.
//!
//! The JSON shape matches the TS type field-for-field, so a run saved by one runtime reads in
//! the other.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::scheduled_run_time::{is_valid_time_zone, zoned_time_to_instant};
use crate::types::WorkflowArtifactRef;

pub const SCHEDULED_RUN_SCHEMA_VERSION: u32 = 1;
/// The most tickets a parallel run may have going at once.
pub const MAX_SCHEDULED_CONCURRENCY: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledRunStatus {
    Draft,
    Scheduled,
    Missed,
    Running,
    Paused,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledEntryStatus {
    Queued,
    Running,
    Paused,
    Done,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTicketRef {
    pub connection_id: String,
    pub issue_key: String,
    pub title: String,
}

/// A provider switch made mid-ticket because the first was nearly out of allowance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledHandover {
    pub at: String,
    pub from: String,
    pub to: String,
    /// 0-100, the allowance the first provider had used when the switch happened.
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_ref: Option<String>,
}

/// An approval gate the ticket's workflow is waiting at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledEntryGate {
    pub node_id: String,
    pub label: String,
    pub since: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledEntryDecision {
    pub at: String,
    pub kind: ScheduledRunEventKind,
    pub message: String,
}

/// What a ticket's run has cost so far. `estimated` marks a figure the provider did not report.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledEntrySpend {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct EstimateRange {
    pub low: f64,
    pub high: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateSpendRange {
    pub low: f64,
    pub high: f64,
    pub currency: String,
}

/// The first observed estimate, kept apart from actual spend. Only the fields the store persists.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledEntryEstimate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<EstimateRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend: Option<EstimateSpendRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_estimable: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub based_on_sessions: Option<f64>,
}

/// What happened to one queue entry once the run started. Written by the runner, not the editor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledEntryOutcome {
    pub status: ScheduledEntryStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Written and saved before the workflow run launches. After a crash, an entry that is
    /// running with a token but no `workflow_run_id` is looked up by token, so a ticket is never
    /// launched twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<ScheduledEntryGate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decisions: Vec<ScheduledEntryDecision>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub handovers: Vec<ScheduledHandover>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend: Option<ScheduledEntrySpend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate: Option<ScheduledEntryEstimate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<WorkflowArtifactRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retries: Option<u32>,
    /// Why a paused entry stopped, so the run can pause for it again after another entry settles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_reason: Option<ScheduledPauseReason>,
    /// Parallel mode only: the lane (1 to `maxConcurrency`) the ticket started in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane_reason: Option<String>,
    /// Providers that ran out while this ticket was worked on. They are never started again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exhausted: Vec<String>,
}

impl ScheduledEntryOutcome {
    /// An outcome with nothing recorded yet.
    #[must_use]
    pub fn queued() -> Self {
        Self {
            status: ScheduledEntryStatus::Queued,
            session_id: None,
            workflow_run_id: None,
            started_at: None,
            ended_at: None,
            reason: None,
            provider: None,
            launch_token: None,
            gate: None,
            decisions: Vec::new(),
            handovers: Vec::new(),
            spend: None,
            estimate: None,
            artifacts: Vec::new(),
            retries: None,
            wait_reason: None,
            lane: None,
            lane_reason: None,
            exhausted: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledQueueEntry {
    /// Stable for the life of the schedule, even as `sequence` changes.
    pub id: String,
    /// 1-based and contiguous.
    pub sequence: u32,
    pub ticket: ScheduledTicketRef,
    /// True when this ticket shares a step with the entry before it. Never set on the first entry.
    #[serde(default, skip_serializing_if = "is_false")]
    pub with_previous: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ScheduledEntryOutcome>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduledRunTrigger {
    Schedule,
    StartNow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRunAttempt {
    pub id: String,
    pub trigger: ScheduledRunTrigger,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduledRunEventKind {
    Created,
    Renamed,
    TicketsAdded,
    TicketRemoved,
    Reordered,
    Rescheduled,
    Armed,
    Held,
    Missed,
    StartNow,
    Skipped,
    WorkflowChanged,
    Started,
    EntryLaunching,
    EntryStarted,
    EntryGate,
    GateDecided,
    LoopDecided,
    EntryDone,
    EntryFailed,
    EntrySkipped,
    EntryRetried,
    Paused,
    Resumed,
    BudgetChecked,
    ProviderHandover,
    /// The runner moved the ticket on its board.
    TicketStatus,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRunEvent {
    pub at: String,
    pub kind: ScheduledRunEventKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
}

/// How a run's tickets are started. `sequential` runs one at a time. `parallel` lets one step's
/// tickets overlap, never more than `maxConcurrency` at once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum ScheduledRunPolicy {
    #[serde(rename_all = "camelCase")]
    Sequential {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workflow_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Parallel {
        max_concurrency: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workflow_id: Option<String>,
    },
}

impl ScheduledRunPolicy {
    fn workflow_id(&self) -> Option<&String> {
        match self {
            Self::Sequential { workflow_id } | Self::Parallel { workflow_id, .. } => {
                workflow_id.as_ref()
            }
        }
    }
}

/// How many tickets may run at once: 1 for a sequential run.
#[must_use]
pub fn scheduled_concurrency(policy: &ScheduledRunPolicy) -> u32 {
    match policy {
        ScheduledRunPolicy::Parallel {
            max_concurrency, ..
        } => *max_concurrency,
        ScheduledRunPolicy::Sequential { .. } => 1,
    }
}

/// The policy for a requested concurrency. Anything but a whole number from 1 to the maximum is refused.
pub fn scheduled_policy_for(
    max_concurrency: Option<i64>,
    workflow_id: Option<&str>,
) -> Result<ScheduledRunPolicy, String> {
    let id = workflow_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let value = max_concurrency.unwrap_or(1);
    if !(1..=i64::from(MAX_SCHEDULED_CONCURRENCY)).contains(&value) {
        return Err(format!(
            "Tickets at once must be a whole number from 1 to {MAX_SCHEDULED_CONCURRENCY}."
        ));
    }
    let max = u32::try_from(value).map_err(|_| "Tickets at once is out of range.".to_string())?;
    Ok(if max == 1 {
        ScheduledRunPolicy::Sequential { workflow_id: id }
    } else {
        ScheduledRunPolicy::Parallel {
            max_concurrency: max,
            workflow_id: id,
        }
    })
}

/// Why a running schedule stopped and is waiting for the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduledPauseReason {
    Budget,
    Approval,
    Policy,
    Trust,
    NoProvider,
    Failure,
    User,
    LaunchInterrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRunPause {
    pub reason: ScheduledPauseReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    pub message: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Absolute UTC instant, ISO 8601.
    pub scheduled_start_at: String,
    /// IANA zone the user picked. Display and editing only.
    pub timezone: String,
    pub policy: ScheduledRunPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_branch_name: Option<String>,
    pub entries: Vec<ScheduledQueueEntry>,
    pub status: ScheduledRunStatus,
    pub attempts: Vec<ScheduledRunAttempt>,
    /// Present only while `status` is `paused`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<ScheduledRunPause>,
    pub created_at: String,
    pub updated_at: String,
    pub events: Vec<ScheduledRunEvent>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

/// Statuses in which the definition may still be edited.
#[must_use]
pub fn is_scheduled_run_editable(status: ScheduledRunStatus) -> bool {
    matches!(
        status,
        ScheduledRunStatus::Draft | ScheduledRunStatus::Scheduled
    )
}

#[must_use]
pub fn new_scheduled_id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}

#[must_use]
pub fn ticket_ref_key(connection_id: &str, issue_key: &str) -> String {
    format!("{connection_id}\u{0}{issue_key}")
}

fn ticket_key(ticket: &ScheduledTicketRef) -> String {
    ticket_ref_key(&ticket.connection_id, &ticket.issue_key)
}

/// Milliseconds since the epoch for an RFC 3339 instant, or `None` when it is not one.
fn instant_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn is_valid_instant(value: &str) -> bool {
    instant_ms(value).is_some()
}

/// Normalises an instant to the canonical `....sssZ` form the store writes.
fn to_iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn ms_of(value: &str) -> i64 {
    instant_ms(value).unwrap_or(i64::MIN)
}

fn renumber(entries: &[ScheduledQueueEntry]) -> Vec<ScheduledQueueEntry> {
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let sequence = u32::try_from(index + 1).unwrap_or(u32::MAX);
            let mut next = entry.clone();
            if index == 0 {
                next.with_previous = false;
            }
            next.sequence = sequence;
            next
        })
        .collect()
}

/// Public renumbering for callers that rebuild a queue.
#[must_use]
pub fn renumber_entries(entries: &[ScheduledQueueEntry]) -> Vec<ScheduledQueueEntry> {
    renumber(entries)
}

/// Groups a queue into steps. Each step is one entry, or a run of entries that share it.
#[must_use]
pub fn scheduled_steps(entries: &[ScheduledQueueEntry]) -> Vec<Vec<&ScheduledQueueEntry>> {
    let mut steps: Vec<Vec<&ScheduledQueueEntry>> = Vec::new();
    for entry in entries {
        match steps.last_mut() {
            Some(step) if entry.with_previous => step.push(entry),
            _ => steps.push(vec![entry]),
        }
    }
    steps
}

/// One event to record alongside a change.
#[derive(Debug, Clone)]
pub struct EventDraft {
    pub kind: ScheduledRunEventKind,
    pub message: String,
    pub entry_id: Option<String>,
}

impl EventDraft {
    fn new(kind: ScheduledRunEventKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            entry_id: None,
        }
    }
}

/// Stamps a change with the time it happened and optionally records an event.
#[must_use]
pub fn touch(mut run: ScheduledRun, at: &str, event: Option<EventDraft>) -> ScheduledRun {
    run.updated_at = at.to_string();
    if let Some(draft) = event {
        run.events.push(ScheduledRunEvent {
            at: at.to_string(),
            kind: draft.kind,
            message: draft.message,
            entry_id: draft.entry_id,
        });
    }
    run
}

fn assert_editable(run: &ScheduledRun) -> Result<(), String> {
    if is_scheduled_run_editable(run.status) {
        Ok(())
    } else {
        Err(format!(
            "A {} run can no longer be edited. Duplicate it to plan another.",
            status_word(run.status)
        ))
    }
}

fn status_word(status: ScheduledRunStatus) -> &'static str {
    match status {
        ScheduledRunStatus::Draft => "draft",
        ScheduledRunStatus::Scheduled => "scheduled",
        ScheduledRunStatus::Missed => "missed",
        ScheduledRunStatus::Running => "running",
        ScheduledRunStatus::Paused => "paused",
        ScheduledRunStatus::Completed => "completed",
        ScheduledRunStatus::Cancelled => "cancelled",
        ScheduledRunStatus::Failed => "failed",
    }
}

#[derive(Debug, Clone)]
pub struct CreateScheduledRunInput {
    pub id: Option<String>,
    pub project_id: Option<String>,
    pub name: String,
    pub scheduled_start_at: String,
    pub timezone: String,
    pub tickets: Vec<ScheduledTicketRef>,
    /// `ticket_ref_key`s of tickets that share a step with the ticket before them.
    pub with_previous: Vec<String>,
    pub workflow_id: Option<String>,
    /// Tickets allowed at once. 1 or absent is sequential.
    pub max_concurrency: Option<i64>,
    pub at: String,
}

/// A new schedule starts as a draft. Arming it is a separate, explicit step.
pub fn create_scheduled_run(input: CreateScheduledRunInput) -> Result<ScheduledRun, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("A scheduled run needs a name.".into());
    }
    if !is_valid_instant(&input.scheduled_start_at) {
        return Err("The start time is not a valid date and time.".into());
    }
    if !is_valid_time_zone(&input.timezone) {
        return Err(format!("\"{}\" is not a known timezone.", input.timezone));
    }

    let together: HashSet<&str> = input.with_previous.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    let mut collected = Vec::new();
    for ticket in &input.tickets {
        let key = ticket_key(ticket);
        if !seen.insert(key.clone()) {
            continue;
        }
        collected.push(ScheduledQueueEntry {
            id: new_scheduled_id("entry"),
            sequence: u32::try_from(collected.len() + 1).unwrap_or(u32::MAX),
            ticket: ticket.clone(),
            with_previous: together.contains(key.as_str()),
            outcome: None,
        });
    }
    let entries = renumber(&collected);
    let count = entries.len();
    let policy = scheduled_policy_for(input.max_concurrency, input.workflow_id.as_deref())?;

    Ok(ScheduledRun {
        schema_version: SCHEDULED_RUN_SCHEMA_VERSION,
        id: input.id.unwrap_or_else(|| new_scheduled_id("run")),
        name,
        project_id: input.project_id.filter(|p| !p.is_empty()),
        scheduled_start_at: to_iso(ms_of(&input.scheduled_start_at)),
        timezone: input.timezone,
        policy,
        delivery_branch_name: None,
        entries,
        status: ScheduledRunStatus::Draft,
        attempts: Vec::new(),
        pause: None,
        created_at: input.at.clone(),
        updated_at: input.at.clone(),
        events: vec![ScheduledRunEvent {
            at: input.at,
            kind: ScheduledRunEventKind::Created,
            message: format!(
                "Created with {count} ticket{}.",
                if count == 1 { "" } else { "s" }
            ),
            entry_id: None,
        }],
        archived: false,
        archived_at: None,
    })
}

pub fn rename_scheduled_run(
    run: ScheduledRun,
    name: &str,
    at: &str,
) -> Result<ScheduledRun, String> {
    assert_editable(&run)?;
    let next = name.trim().to_string();
    if next.is_empty() {
        return Err("A scheduled run needs a name.".into());
    }
    if next == run.name {
        return Ok(run);
    }
    let message = format!("Renamed to \"{next}\".");
    let mut renamed = run;
    renamed.name = next;
    Ok(touch(
        renamed,
        at,
        Some(EventDraft::new(ScheduledRunEventKind::Renamed, message)),
    ))
}

/// Adds tickets to the end of the queue. A ticket already queued is ignored.
pub fn add_tickets_to_scheduled_run(
    run: ScheduledRun,
    tickets: &[ScheduledTicketRef],
    at: &str,
) -> Result<ScheduledRun, String> {
    assert_editable(&run)?;
    let mut seen: HashSet<String> = run.entries.iter().map(|e| ticket_key(&e.ticket)).collect();
    let mut added = Vec::new();
    for ticket in tickets {
        if !seen.insert(ticket_key(ticket)) {
            continue;
        }
        let sequence = u32::try_from(run.entries.len() + added.len() + 1).unwrap_or(u32::MAX);
        added.push(ScheduledQueueEntry {
            id: new_scheduled_id("entry"),
            sequence,
            ticket: ticket.clone(),
            with_previous: false,
            outcome: None,
        });
    }
    if added.is_empty() {
        return Ok(run);
    }
    let message = format!(
        "Added {}.",
        added
            .iter()
            .map(|e| e.ticket.issue_key.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    let mut next = run;
    next.entries.extend(added);
    Ok(touch(
        next,
        at,
        Some(EventDraft::new(
            ScheduledRunEventKind::TicketsAdded,
            message,
        )),
    ))
}

pub fn remove_entry_from_scheduled_run(
    run: ScheduledRun,
    entry_id: &str,
    at: &str,
) -> Result<ScheduledRun, String> {
    assert_editable(&run)?;
    let entry = run
        .entries
        .iter()
        .find(|e| e.id == entry_id)
        .ok_or("That ticket is not in this schedule.")?;
    let message = format!("Removed {}.", entry.ticket.issue_key);
    let remaining: Vec<ScheduledQueueEntry> = run
        .entries
        .iter()
        .filter(|e| e.id != entry_id)
        .cloned()
        .collect();
    let mut next = run;
    next.entries = renumber(&remaining);
    Ok(touch(
        next,
        at,
        Some(EventDraft {
            kind: ScheduledRunEventKind::TicketRemoved,
            message,
            entry_id: Some(entry_id.to_string()),
        }),
    ))
}

/// Moves an entry to a 0-based position. Out-of-range positions clamp.
pub fn move_entry_in_scheduled_run(
    run: ScheduledRun,
    entry_id: &str,
    to_index: i64,
    at: &str,
) -> Result<ScheduledRun, String> {
    assert_editable(&run)?;
    let from = run
        .entries
        .iter()
        .position(|e| e.id == entry_id)
        .ok_or("That ticket is not in this schedule.")?;
    let last = i64::try_from(run.entries.len() - 1).unwrap_or(0);
    let target = usize::try_from(to_index.clamp(0, last)).unwrap_or(0);
    if target == from {
        return Ok(run);
    }
    let mut entries = run.entries.clone();
    let moved = entries.remove(from);
    let message = format!(
        "Moved {} to position {}.",
        moved.ticket.issue_key,
        target + 1
    );
    entries.insert(target, moved);
    let mut next = run;
    next.entries = renumber(&entries);
    Ok(touch(
        next,
        at,
        Some(EventDraft {
            kind: ScheduledRunEventKind::Reordered,
            message,
            entry_id: Some(entry_id.to_string()),
        }),
    ))
}

pub fn reschedule_scheduled_run(
    run: ScheduledRun,
    scheduled_start_at: &str,
    timezone: &str,
    at: &str,
) -> Result<ScheduledRun, String> {
    assert_editable(&run)?;
    if !is_valid_instant(scheduled_start_at) {
        return Err("The start time is not a valid date and time.".into());
    }
    if !is_valid_time_zone(timezone) {
        return Err(format!("\"{timezone}\" is not a known timezone."));
    }
    let instant = to_iso(ms_of(scheduled_start_at));
    if instant == run.scheduled_start_at && timezone == run.timezone {
        return Ok(run);
    }
    let message = format!("Start set to {instant} ({timezone}).");
    let mut next = run;
    next.scheduled_start_at = instant;
    next.timezone = timezone.to_string();
    Ok(touch(
        next,
        at,
        Some(EventDraft::new(ScheduledRunEventKind::Rescheduled, message)),
    ))
}

/// Arms a draft so it starts at its time. It needs a ticket and a start that has not passed.
pub fn arm_scheduled_run(run: ScheduledRun, at: &str) -> Result<ScheduledRun, String> {
    if run.status == ScheduledRunStatus::Scheduled {
        return Ok(run);
    }
    if run.status != ScheduledRunStatus::Draft {
        return Err(format!(
            "A {} run cannot be armed.",
            status_word(run.status)
        ));
    }
    if run.entries.is_empty() {
        return Err("Add at least one ticket before scheduling the run.".into());
    }
    if ms_of(&run.scheduled_start_at) <= ms_of(at) {
        return Err("The start time has already passed. Choose a later time.".into());
    }
    let mut next = run;
    next.status = ScheduledRunStatus::Scheduled;
    Ok(touch(
        next,
        at,
        Some(EventDraft::new(ScheduledRunEventKind::Armed, "Scheduled.")),
    ))
}

/// Takes an armed schedule back to a draft so it will not start.
pub fn hold_scheduled_run(run: ScheduledRun, at: &str) -> Result<ScheduledRun, String> {
    if run.status == ScheduledRunStatus::Draft {
        return Ok(run);
    }
    if run.status != ScheduledRunStatus::Scheduled {
        return Err(format!(
            "A {} run cannot be put on hold.",
            status_word(run.status)
        ));
    }
    let mut next = run;
    next.status = ScheduledRunStatus::Draft;
    Ok(touch(
        next,
        at,
        Some(EventDraft::new(ScheduledRunEventKind::Held, "Put on hold.")),
    ))
}

/// On launch, an armed run whose time passed was missed while Praxis was not there to start it.
#[must_use]
pub fn reconcile_scheduled_run_on_launch(run: ScheduledRun, now: &str) -> ScheduledRun {
    if run.status != ScheduledRunStatus::Scheduled {
        return run;
    }
    if ms_of(&run.scheduled_start_at) > ms_of(now) {
        return run;
    }
    let message = format!(
        "Due {} while Praxis was not running.",
        run.scheduled_start_at
    );
    let mut next = run;
    next.status = ScheduledRunStatus::Missed;
    touch(
        next,
        now,
        Some(EventDraft::new(ScheduledRunEventKind::Missed, message)),
    )
}

/// Makes a draft, a future schedule, or a missed run due now at the user's request.
pub fn start_scheduled_run_now(run: ScheduledRun, at: &str) -> Result<ScheduledRun, String> {
    if !matches!(
        run.status,
        ScheduledRunStatus::Draft | ScheduledRunStatus::Scheduled | ScheduledRunStatus::Missed
    ) {
        return Err(format!(
            "A {} run cannot be started now.",
            status_word(run.status)
        ));
    }
    if run.entries.is_empty() {
        return Err("Add at least one ticket before starting the run.".into());
    }
    let mut next = run;
    next.status = ScheduledRunStatus::Scheduled;
    next.scheduled_start_at = to_iso(ms_of(at));
    Ok(touch(
        next,
        at,
        Some(EventDraft::new(
            ScheduledRunEventKind::StartNow,
            "Run now requested by the user.",
        )),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissedResolution {
    StartNow,
    Skip,
}

/// Resolves a missed run. `StartNow` re-arms it for the current moment. `Skip` cancels it.
pub fn resolve_missed_scheduled_run(
    run: ScheduledRun,
    resolution: MissedResolution,
    at: &str,
) -> Result<ScheduledRun, String> {
    if run.status != ScheduledRunStatus::Missed {
        return Err("Only a missed run needs this decision.".into());
    }
    let mut next = run;
    match resolution {
        MissedResolution::Skip => {
            next.status = ScheduledRunStatus::Cancelled;
            Ok(touch(
                next,
                at,
                Some(EventDraft::new(
                    ScheduledRunEventKind::Skipped,
                    "Skipped by the user.",
                )),
            ))
        }
        MissedResolution::StartNow => {
            next.status = ScheduledRunStatus::Scheduled;
            next.scheduled_start_at = to_iso(ms_of(at));
            Ok(touch(
                next,
                at,
                Some(EventDraft::new(
                    ScheduledRunEventKind::StartNow,
                    "Started late at the user\u{2019}s request.",
                )),
            ))
        }
    }
}

/// Armed runs whose time has come, earliest first. Archived runs never fire.
#[must_use]
pub fn due_scheduled_runs(runs: &[ScheduledRun], now: &str) -> Vec<ScheduledRun> {
    let cutoff = ms_of(now);
    let mut due: Vec<ScheduledRun> = runs
        .iter()
        .filter(|r| {
            !r.archived
                && r.status == ScheduledRunStatus::Scheduled
                && ms_of(&r.scheduled_start_at) <= cutoff
        })
        .cloned()
        .collect();
    due.sort_by_key(|r| ms_of(&r.scheduled_start_at));
    due
}

/// The next armed run that has not started. Archived runs are ignored.
#[must_use]
pub fn next_scheduled_run(runs: &[ScheduledRun]) -> Option<ScheduledRun> {
    let mut armed: Vec<&ScheduledRun> = runs
        .iter()
        .filter(|r| !r.archived && r.status == ScheduledRunStatus::Scheduled)
        .collect();
    armed.sort_by_key(|r| ms_of(&r.scheduled_start_at));
    armed.first().map(|r| (*r).clone())
}

/// What the schedule editor submits: the whole definition, tickets in run order.
#[derive(Debug, Clone)]
pub struct ComposeScheduledRunInput {
    pub project_id: Option<String>,
    pub name: String,
    /// Wall-clock start, interpreted in `timezone`: `YYYY-MM-DD` and `HH:mm`.
    pub date: String,
    pub time: String,
    pub timezone: String,
    /// In run order. The position becomes the sequence.
    pub tickets: Vec<ScheduledTicketRef>,
    pub with_previous: Vec<String>,
    pub workflow_id: Option<String>,
    pub max_concurrency: Option<i64>,
    /// True to schedule it, false to keep it as a draft.
    pub arm: bool,
    pub at: String,
}

/// Builds or updates a schedule from the editor's submission. An entry for a ticket already
/// queued keeps its id, so its history stays attached. A removed ticket drops out.
pub fn compose_scheduled_run(
    existing: Option<ScheduledRun>,
    input: ComposeScheduledRunInput,
) -> Result<ScheduledRun, String> {
    let start_at = zoned_time_to_instant(&input.date, &input.time, &input.timezone);
    if !is_valid_time_zone(&input.timezone) {
        return Err(format!("\"{}\" is not a known timezone.", input.timezone));
    }
    let start_at = start_at.ok_or_else(|| {
        format!(
            "{} {} is not a valid time in {}. Clocks may change at that hour; pick another time.",
            input.date, input.time, input.timezone
        )
    })?;

    let run = match existing {
        None => create_scheduled_run(CreateScheduledRunInput {
            id: None,
            project_id: input.project_id.clone(),
            name: input.name.clone(),
            scheduled_start_at: start_at.clone(),
            timezone: input.timezone.clone(),
            tickets: input.tickets.clone(),
            with_previous: input.with_previous.clone(),
            workflow_id: input.workflow_id.clone(),
            max_concurrency: input.max_concurrency,
            at: input.at.clone(),
        })?,
        Some(existing) => {
            assert_editable(&existing)?;
            let policy = scheduled_policy_for(input.max_concurrency, input.workflow_id.as_deref())?;
            let mut run = if existing.name == input.name.trim() {
                existing
            } else {
                rename_scheduled_run(existing, &input.name, &input.at)?
            };
            run = reschedule_scheduled_run(run, &start_at, &input.timezone, &input.at)?;
            run = replace_queue(run, &input.tickets, &input.with_previous, &input.at);
            run = set_policy(run, policy, &input.at);
            if run.status == ScheduledRunStatus::Scheduled && !input.arm {
                run = hold_scheduled_run(run, &input.at)?;
            }
            run
        }
    };
    if input.arm && ms_of(&run.scheduled_start_at) <= ms_of(&input.at) {
        return Err("The start time has already passed. Choose a later time.".into());
    }
    if input.arm {
        arm_scheduled_run(run, &input.at)
    } else {
        Ok(run)
    }
}

fn set_policy(run: ScheduledRun, policy: ScheduledRunPolicy, at: &str) -> ScheduledRun {
    let workflow_changed = policy.workflow_id() != run.policy.workflow_id();
    let lanes_changed = scheduled_concurrency(&policy) != scheduled_concurrency(&run.policy);
    if !workflow_changed && !lanes_changed {
        return run;
    }
    let lanes = scheduled_concurrency(&policy);
    let workflow_message = policy.workflow_id().map_or_else(
        || "Workflow cleared.".to_string(),
        |id| format!("Workflow set to {id}."),
    );
    let mut next = run;
    next.policy = policy;
    next = touch(next, at, None);
    if workflow_changed {
        next = touch(
            next,
            at,
            Some(EventDraft::new(
                ScheduledRunEventKind::WorkflowChanged,
                workflow_message,
            )),
        );
    }
    if lanes_changed {
        let message = if lanes > 1 {
            format!("Up to {lanes} tickets of a shared step may run at once.")
        } else {
            "Tickets run one at a time.".to_string()
        };
        next = touch(
            next,
            at,
            Some(EventDraft::new(
                ScheduledRunEventKind::WorkflowChanged,
                message,
            )),
        );
    }
    next
}

fn replace_queue(
    run: ScheduledRun,
    tickets: &[ScheduledTicketRef],
    with_previous: &[String],
    at: &str,
) -> ScheduledRun {
    let existing: HashMap<String, ScheduledQueueEntry> = run
        .entries
        .iter()
        .map(|e| (ticket_key(&e.ticket), e.clone()))
        .collect();
    let together: HashSet<&str> = with_previous.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    let mut next = Vec::new();
    for ticket in tickets {
        let key = ticket_key(ticket);
        if !seen.insert(key.clone()) {
            continue;
        }
        let mut entry = match existing.get(&key) {
            Some(kept) => {
                let mut kept = kept.clone();
                if !ticket.title.is_empty() {
                    kept.ticket.title = ticket.title.clone();
                }
                kept
            }
            None => ScheduledQueueEntry {
                id: new_scheduled_id("entry"),
                sequence: 0,
                ticket: ticket.clone(),
                with_previous: false,
                outcome: None,
            },
        };
        entry.with_previous = together.contains(key.as_str());
        next.push(entry);
    }
    let entries = renumber(&next);

    let step_shape = |list: &[ScheduledQueueEntry]| {
        scheduled_steps(list)
            .iter()
            .map(|step| {
                step.iter()
                    .map(|e| ticket_key(&e.ticket))
                    .collect::<Vec<_>>()
                    .join("+")
            })
            .collect::<Vec<_>>()
            .join(",")
    };
    let regrouped = step_shape(&entries) != step_shape(&run.entries);

    let removed: Vec<&ScheduledQueueEntry> = run
        .entries
        .iter()
        .filter(|e| !seen.contains(&ticket_key(&e.ticket)))
        .collect();
    let added: Vec<&ScheduledQueueEntry> = entries
        .iter()
        .filter(|e| !existing.contains_key(&ticket_key(&e.ticket)))
        .collect();
    let survivors_before: Vec<&str> = run
        .entries
        .iter()
        .filter(|e| seen.contains(&ticket_key(&e.ticket)))
        .map(|e| e.id.as_str())
        .collect();
    let survivors_after: Vec<&str> = entries
        .iter()
        .filter(|e| existing.contains_key(&ticket_key(&e.ticket)))
        .map(|e| e.id.as_str())
        .collect();
    let reordered = survivors_before
        .iter()
        .enumerate()
        .any(|(i, id)| survivors_after.get(i) != Some(id));

    if removed.is_empty() && added.is_empty() && !reordered && !regrouped {
        return run;
    }

    let mut drafts = Vec::new();
    for entry in &removed {
        drafts.push(EventDraft {
            kind: ScheduledRunEventKind::TicketRemoved,
            message: format!("Removed {}.", entry.ticket.issue_key),
            entry_id: Some(entry.id.clone()),
        });
    }
    if !added.is_empty() {
        drafts.push(EventDraft::new(
            ScheduledRunEventKind::TicketsAdded,
            format!(
                "Added {}.",
                added
                    .iter()
                    .map(|e| e.ticket.issue_key.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    if reordered || regrouped {
        let order = scheduled_steps(&entries)
            .iter()
            .map(|step| {
                step.iter()
                    .map(|e| e.ticket.issue_key.as_str())
                    .collect::<Vec<_>>()
                    .join(" + ")
            })
            .collect::<Vec<_>>()
            .join(", ");
        drafts.push(EventDraft::new(
            ScheduledRunEventKind::Reordered,
            format!("Run order is now {order}."),
        ));
    }

    let mut result = run;
    result.entries = entries;
    result = touch(result, at, None);
    for draft in drafts {
        result = touch(result, at, Some(draft));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-20T10:00:00.000Z";
    const LATER: &str = "2026-10-21T21:00:00.000Z";

    fn ticket(key: &str) -> ScheduledTicketRef {
        ticket_on("c1", key)
    }

    fn ticket_on(connection: &str, key: &str) -> ScheduledTicketRef {
        ScheduledTicketRef {
            connection_id: connection.into(),
            issue_key: key.into(),
            title: format!("Title {key}"),
        }
    }

    fn draft_with(keys: &[&str]) -> ScheduledRun {
        create_scheduled_run(CreateScheduledRunInput {
            id: None,
            project_id: None,
            name: "Nightly".into(),
            scheduled_start_at: LATER.into(),
            timezone: "Europe/London".into(),
            tickets: keys.iter().map(|k| ticket(k)).collect(),
            with_previous: vec![],
            workflow_id: Some("governed-delivery".into()),
            max_concurrency: None,
            at: NOW.into(),
        })
        .expect("draft")
    }

    fn draft() -> ScheduledRun {
        draft_with(&["PRX-1", "PRX-2", "PRX-3"])
    }

    fn keys(run: &ScheduledRun) -> Vec<&str> {
        run.entries
            .iter()
            .map(|e| e.ticket.issue_key.as_str())
            .collect()
    }

    fn sequences(run: &ScheduledRun) -> Vec<u32> {
        run.entries.iter().map(|e| e.sequence).collect()
    }

    fn form(tickets: Vec<ScheduledTicketRef>) -> ComposeScheduledRunInput {
        ComposeScheduledRunInput {
            project_id: None,
            name: "Nightly".into(),
            date: "2026-10-21".into(),
            time: "22:00".into(),
            timezone: "Europe/London".into(),
            tickets,
            with_previous: vec![],
            workflow_id: None,
            max_concurrency: None,
            arm: false,
            at: NOW.into(),
        }
    }

    #[test]
    fn a_new_schedule_is_a_draft_with_a_contiguous_queue_in_the_order_given() {
        let run = draft();
        assert_eq!(run.status, ScheduledRunStatus::Draft);
        assert_eq!(keys(&run), vec!["PRX-1", "PRX-2", "PRX-3"]);
        assert_eq!(sequences(&run), vec![1, 2, 3]);
        assert!(matches!(run.policy, ScheduledRunPolicy::Sequential { .. }));
        assert!(run.attempts.is_empty());
        let ids: HashSet<_> = run.entries.iter().map(|e| e.id.clone()).collect();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn empty_and_single_ticket_schedules_are_valid_definitions() {
        assert!(draft_with(&[]).entries.is_empty());
        assert_eq!(sequences(&draft_with(&["PRX-9"])), vec![1]);
    }

    #[test]
    fn creation_validates_the_name_start_and_timezone() {
        let base = |name: &str, start: &str, tz: &str| CreateScheduledRunInput {
            id: None,
            project_id: None,
            name: name.into(),
            scheduled_start_at: start.into(),
            timezone: tz.into(),
            tickets: vec![],
            with_previous: vec![],
            workflow_id: None,
            max_concurrency: None,
            at: NOW.into(),
        };
        assert!(
            create_scheduled_run(base("   ", LATER, "UTC"))
                .expect_err("name")
                .contains("needs a name")
        );
        assert!(
            create_scheduled_run(base("x", "not a date", "UTC"))
                .expect_err("start")
                .contains("not a valid date")
        );
        assert!(
            create_scheduled_run(base("x", LATER, "Mars/Olympus"))
                .expect_err("tz")
                .contains("not a known timezone")
        );
    }

    #[test]
    fn duplicate_tickets_collapse_keyed_by_connection_and_key() {
        let run = create_scheduled_run(CreateScheduledRunInput {
            id: None,
            project_id: None,
            name: "x".into(),
            scheduled_start_at: LATER.into(),
            timezone: "UTC".into(),
            tickets: vec![ticket("PRX-1"), ticket("PRX-1"), ticket_on("c2", "PRX-1")],
            with_previous: vec![],
            workflow_id: None,
            max_concurrency: None,
            at: NOW.into(),
        })
        .expect("create");
        assert_eq!(run.entries.len(), 2);
    }

    #[test]
    fn reordering_renumbers_and_keeps_entry_ids_stable() {
        let run = draft();
        let ids: Vec<String> = run.entries.iter().map(|e| e.id.clone()).collect();
        let moved = move_entry_in_scheduled_run(run.clone(), &ids[2], 0, NOW).expect("move");
        assert_eq!(keys(&moved), vec!["PRX-3", "PRX-1", "PRX-2"]);
        assert_eq!(sequences(&moved), vec![1, 2, 3]);
        assert_eq!(
            moved
                .entries
                .iter()
                .map(|e| e.id.clone())
                .collect::<Vec<_>>(),
            vec![ids[2].clone(), ids[0].clone(), ids[1].clone()]
        );
        assert_eq!(
            moved.events.last().map(|e| e.kind),
            Some(ScheduledRunEventKind::Reordered)
        );
        assert_eq!(keys(&run), vec!["PRX-1", "PRX-2", "PRX-3"]);
    }

    #[test]
    fn moving_clamps_out_of_range_positions_and_ignores_a_no_op_move() {
        let run = draft();
        let first = run.entries[0].id.clone();
        let end = move_entry_in_scheduled_run(run.clone(), &first, 99, NOW).expect("move end");
        assert_eq!(keys(&end), vec!["PRX-2", "PRX-3", "PRX-1"]);
        let back = move_entry_in_scheduled_run(end, &first, -5, NOW);
        assert_eq!(
            keys(&back.clone().expect("move back")),
            vec!["PRX-1", "PRX-2", "PRX-3"]
        );
        assert_eq!(
            move_entry_in_scheduled_run(run.clone(), &first, 0, NOW).expect("noop"),
            run
        );
        assert!(
            move_entry_in_scheduled_run(run, "nope", 0, NOW)
                .expect_err("unknown")
                .contains("not in this schedule")
        );
    }

    #[test]
    fn removing_renumbers_and_adding_appends_skipping_queued_tickets() {
        let run = draft();
        let second = run.entries[1].id.clone();
        let run = remove_entry_from_scheduled_run(run, &second, NOW).expect("remove");
        assert_eq!(keys(&run), vec!["PRX-1", "PRX-3"]);
        assert_eq!(sequences(&run), vec![1, 2]);

        let added = add_tickets_to_scheduled_run(
            run.clone(),
            &[ticket("PRX-3"), ticket("PRX-4"), ticket("PRX-5")],
            NOW,
        )
        .expect("add");
        assert_eq!(keys(&added), vec!["PRX-1", "PRX-3", "PRX-4", "PRX-5"]);
        assert_eq!(sequences(&added), vec![1, 2, 3, 4]);
        assert_eq!(
            add_tickets_to_scheduled_run(added.clone(), &[ticket("PRX-4")], NOW).expect("noop"),
            added
        );
    }

    #[test]
    fn the_board_is_never_consulted_order_lives_only_on_the_schedule() {
        let before = draft();
        let first = before.entries[0].id.clone();
        let run = move_entry_in_scheduled_run(before, &first, 2, NOW).expect("move");
        let json = serde_json::to_value(&run.entries[0]).expect("json");
        let mut fields: Vec<&str> = json
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        assert_eq!(fields, vec!["id", "sequence", "ticket"]);
        assert_eq!(keys(&run), vec!["PRX-2", "PRX-3", "PRX-1"]);
    }

    #[test]
    fn rename_and_reschedule_validate_and_record_events() {
        let mut run = rename_scheduled_run(draft(), "  Sprint 42  ", NOW).expect("rename");
        assert_eq!(run.name, "Sprint 42");
        assert!(rename_scheduled_run(run.clone(), " ", NOW).is_err());
        run = reschedule_scheduled_run(run, "2026-11-01T09:00:00Z", "America/New_York", NOW)
            .expect("reschedule");
        assert_eq!(run.scheduled_start_at, "2026-11-01T09:00:00.000Z");
        assert_eq!(run.timezone, "America/New_York");
        assert_eq!(
            run.events.last().map(|e| e.kind),
            Some(ScheduledRunEventKind::Rescheduled)
        );
        assert!(
            reschedule_scheduled_run(run, "junk", "UTC", NOW)
                .expect_err("bad")
                .contains("not a valid date")
        );
    }

    #[test]
    fn arming_needs_a_ticket_and_a_future_start_and_hold_reverses_it() {
        assert!(
            arm_scheduled_run(draft_with(&[]), NOW)
                .expect_err("empty")
                .contains("at least one ticket")
        );
        let past = create_scheduled_run(CreateScheduledRunInput {
            id: None,
            project_id: None,
            name: "x".into(),
            scheduled_start_at: "2026-10-19T00:00:00Z".into(),
            timezone: "UTC".into(),
            tickets: vec![ticket("PRX-1")],
            with_previous: vec![],
            workflow_id: None,
            max_concurrency: None,
            at: NOW.into(),
        })
        .expect("past");
        assert!(
            arm_scheduled_run(past, NOW)
                .expect_err("past")
                .contains("already passed")
        );

        let armed = arm_scheduled_run(draft(), NOW).expect("arm");
        assert_eq!(armed.status, ScheduledRunStatus::Scheduled);
        assert_eq!(arm_scheduled_run(armed.clone(), NOW).expect("again"), armed);
        assert_eq!(
            hold_scheduled_run(armed, NOW).expect("hold").status,
            ScheduledRunStatus::Draft
        );
    }

    #[test]
    fn only_draft_and_scheduled_runs_can_be_edited() {
        let missed = reconcile_scheduled_run_on_launch(
            arm_scheduled_run(draft(), NOW).expect("arm"),
            "2026-10-22T00:00:00Z",
        );
        assert_eq!(missed.status, ScheduledRunStatus::Missed);
        assert!(
            rename_scheduled_run(missed.clone(), "x", NOW)
                .expect_err("rename")
                .contains("can no longer be edited")
        );
        assert!(
            add_tickets_to_scheduled_run(missed, &[ticket("PRX-9")], NOW)
                .expect_err("add")
                .contains("can no longer be edited")
        );
    }

    #[test]
    fn a_start_that_passed_while_closed_becomes_missed_and_only_a_choice_resolves_it() {
        let armed = arm_scheduled_run(draft(), NOW).expect("arm");
        assert_eq!(
            reconcile_scheduled_run_on_launch(armed.clone(), "2026-10-21T20:59:59Z"),
            armed
        );

        let missed = reconcile_scheduled_run_on_launch(armed.clone(), "2026-10-22T08:00:00Z");
        assert_eq!(missed.status, ScheduledRunStatus::Missed);
        assert_eq!(
            missed.events.last().map(|e| e.kind),
            Some(ScheduledRunEventKind::Missed)
        );
        assert!(
            due_scheduled_runs(std::slice::from_ref(&missed), "2026-10-22T08:00:00Z").is_empty()
        );

        let skipped = resolve_missed_scheduled_run(
            missed.clone(),
            MissedResolution::Skip,
            "2026-10-22T08:01:00Z",
        )
        .expect("skip");
        assert_eq!(skipped.status, ScheduledRunStatus::Cancelled);

        let late = resolve_missed_scheduled_run(
            missed.clone(),
            MissedResolution::StartNow,
            "2026-10-22T08:01:00Z",
        )
        .expect("late");
        assert_eq!(late.status, ScheduledRunStatus::Scheduled);
        assert_eq!(late.scheduled_start_at, "2026-10-22T08:01:00.000Z");
        assert_eq!(
            due_scheduled_runs(std::slice::from_ref(&late), "2026-10-22T08:01:00Z")
                .iter()
                .map(|r| r.id.clone())
                .collect::<Vec<_>>(),
            vec![late.id.clone()]
        );
        assert!(
            resolve_missed_scheduled_run(armed, MissedResolution::Skip, NOW)
                .expect_err("not missed")
                .contains("Only a missed run")
        );
    }

    #[test]
    fn due_and_next_runs_ignore_drafts_and_sort_soonest_first() {
        let make = |name: &str, start: &str, key: &str| {
            create_scheduled_run(CreateScheduledRunInput {
                id: None,
                project_id: None,
                name: name.into(),
                scheduled_start_at: start.into(),
                timezone: "UTC".into(),
                tickets: vec![ticket(key)],
                with_previous: vec![],
                workflow_id: None,
                max_concurrency: None,
                at: NOW.into(),
            })
            .expect("make")
        };
        let a = arm_scheduled_run(make("a", "2026-10-22T10:00:00Z", "A-1"), NOW).expect("a");
        let b = arm_scheduled_run(make("b", "2026-10-21T10:00:00Z", "B-1"), NOW).expect("b");
        let c = make("c", "2026-10-20T11:00:00Z", "C-1");
        let names = |runs: &[ScheduledRun]| runs.iter().map(|r| r.name.clone()).collect::<Vec<_>>();
        assert_eq!(
            next_scheduled_run(&[a.clone(), b.clone(), c.clone()]).map(|r| r.name),
            Some("b".into())
        );
        assert_eq!(
            names(&due_scheduled_runs(
                &[a.clone(), b.clone(), c.clone()],
                "2026-10-22T12:00:00Z"
            )),
            vec!["b", "a"]
        );
        assert!(next_scheduled_run(std::slice::from_ref(&c)).is_none());

        let archived_b = ScheduledRun {
            archived: true,
            ..b
        };
        assert_eq!(
            next_scheduled_run(&[a.clone(), archived_b.clone()]).map(|r| r.name),
            Some("a".into())
        );
        assert_eq!(
            names(&due_scheduled_runs(
                &[a, archived_b],
                "2026-10-22T12:00:00Z"
            )),
            vec!["a"]
        );
    }

    #[test]
    fn composing_a_new_schedule_converts_the_wall_time_and_keeps_the_ticket_order() {
        let run = compose_scheduled_run(
            None,
            form(vec![ticket("PRX-3"), ticket("PRX-1"), ticket("PRX-2")]),
        )
        .expect("compose");
        assert_eq!(run.status, ScheduledRunStatus::Draft);
        assert_eq!(run.scheduled_start_at, "2026-10-21T21:00:00.000Z");
        assert_eq!(keys(&run), vec!["PRX-3", "PRX-1", "PRX-2"]);
        assert_eq!(sequences(&run), vec![1, 2, 3]);
    }

    #[test]
    fn composing_with_arm_schedules_it_and_refuses_an_empty_queue_or_a_past_start() {
        let mut armed = form(vec![ticket("PRX-1")]);
        armed.arm = true;
        assert_eq!(
            compose_scheduled_run(None, armed).expect("armed").status,
            ScheduledRunStatus::Scheduled
        );

        let mut empty = form(vec![]);
        empty.arm = true;
        assert!(
            compose_scheduled_run(None, empty)
                .expect_err("empty")
                .contains("at least one ticket")
        );

        let mut past = form(vec![ticket("PRX-1")]);
        past.arm = true;
        past.date = "2026-10-19".into();
        assert!(
            compose_scheduled_run(None, past)
                .expect_err("past")
                .contains("already passed")
        );
    }

    #[test]
    fn composing_rejects_a_nonexistent_wall_time_and_an_unknown_zone_readably() {
        let mut skipped = form(vec![ticket("PRX-1")]);
        skipped.date = "2027-03-28".into();
        skipped.time = "01:30".into();
        assert!(
            compose_scheduled_run(None, skipped)
                .expect_err("skipped")
                .contains("not a valid time in Europe/London")
        );

        let mut unknown = form(vec![ticket("PRX-1")]);
        unknown.timezone = "Mars/Olympus".into();
        assert!(
            compose_scheduled_run(None, unknown)
                .expect_err("zone")
                .contains("not a known timezone")
        );
    }

    #[test]
    fn editing_keeps_entry_ids_for_surviving_tickets_and_records_what_changed() {
        let first = compose_scheduled_run(
            None,
            form(vec![ticket("PRX-1"), ticket("PRX-2"), ticket("PRX-3")]),
        )
        .expect("first");
        let id = |run: &ScheduledRun, key: &str| {
            run.entries
                .iter()
                .find(|e| e.ticket.issue_key == key)
                .map(|e| e.id.clone())
        };

        let mut edit = form(vec![ticket("PRX-3"), ticket("PRX-1"), ticket("PRX-9")]);
        edit.at = "2026-10-20T11:00:00.000Z".into();
        let edited = compose_scheduled_run(Some(first.clone()), edit).expect("edit");
        assert_eq!(keys(&edited), vec!["PRX-3", "PRX-1", "PRX-9"]);
        assert_eq!(id(&edited, "PRX-1"), id(&first, "PRX-1"));
        assert_eq!(id(&edited, "PRX-3"), id(&first, "PRX-3"));
        assert_eq!(id(&edited, "PRX-2"), None);
        let new_kinds: Vec<_> = edited.events[first.events.len()..]
            .iter()
            .map(|e| e.kind)
            .collect();
        assert_eq!(
            new_kinds,
            vec![
                ScheduledRunEventKind::TicketRemoved,
                ScheduledRunEventKind::TicketsAdded,
                ScheduledRunEventKind::Reordered
            ]
        );
        assert_eq!(edited.id, first.id);
        assert_eq!(edited.created_at, first.created_at);
    }

    #[test]
    fn an_unchanged_resubmission_changes_nothing() {
        let first = compose_scheduled_run(None, form(vec![ticket("PRX-1"), ticket("PRX-2")]))
            .expect("first");
        let again = compose_scheduled_run(
            Some(first.clone()),
            form(vec![ticket("PRX-1"), ticket("PRX-2")]),
        )
        .expect("again");
        assert_eq!(again, first);
    }

    #[test]
    fn editing_an_armed_schedule_can_hold_it_and_a_started_one_cannot_be_edited() {
        let mut armed_form = form(vec![ticket("PRX-1")]);
        armed_form.arm = true;
        let armed = compose_scheduled_run(None, armed_form).expect("armed");
        let held =
            compose_scheduled_run(Some(armed.clone()), form(vec![ticket("PRX-1")])).expect("hold");
        assert_eq!(held.status, ScheduledRunStatus::Draft);
        let running = ScheduledRun {
            status: ScheduledRunStatus::Running,
            ..armed
        };
        assert!(
            compose_scheduled_run(Some(running), form(vec![ticket("PRX-1")]))
                .expect_err("running")
                .contains("can no longer be edited")
        );
    }

    #[test]
    fn moving_an_armed_schedule_to_a_past_time_is_refused_rather_than_quietly_kept() {
        let mut armed_form = form(vec![ticket("PRX-1")]);
        armed_form.arm = true;
        let armed = compose_scheduled_run(None, armed_form).expect("armed");
        let mut past = form(vec![ticket("PRX-1")]);
        past.arm = true;
        past.date = "2026-10-19".into();
        assert!(
            compose_scheduled_run(Some(armed), past)
                .expect_err("past")
                .contains("already passed")
        );
    }

    #[test]
    fn a_schedule_remembers_its_project_and_keeps_it_through_edits() {
        let mut first_form = form(vec![ticket("PRX-1")]);
        first_form.project_id = Some("p1".into());
        let first = compose_scheduled_run(None, first_form).expect("first");
        assert_eq!(first.project_id.as_deref(), Some("p1"));
        let mut edit = form(vec![ticket("PRX-1"), ticket("PRX-2")]);
        edit.project_id = Some("other".into());
        edit.name = "Renamed".into();
        let edited = compose_scheduled_run(Some(first), edit).expect("edit");
        assert_eq!(edited.project_id.as_deref(), Some("p1"));
        assert_eq!(
            compose_scheduled_run(None, form(vec![]))
                .expect("no project")
                .project_id,
            None
        );
    }

    #[test]
    fn tickets_marked_with_previous_share_a_step_with_the_ticket_before_them() {
        let mut input = form(vec![
            ticket("PRX-1"),
            ticket("PRX-2"),
            ticket("PRX-3"),
            ticket("PRX-4"),
        ]);
        input.with_previous = vec![ticket_ref_key("c1", "PRX-3")];
        let run = compose_scheduled_run(None, input).expect("compose");
        assert_eq!(
            steps_of(&run),
            vec![vec!["PRX-1"], vec!["PRX-2", "PRX-3"], vec!["PRX-4"]]
        );
        assert_eq!(sequences(&run), vec![1, 2, 3, 4]);
    }

    #[test]
    fn the_first_ticket_never_shares_a_step_even_when_asked_or_after_the_one_before_is_removed() {
        let mut input = form(vec![ticket("PRX-1"), ticket("PRX-2")]);
        input.with_previous = vec![ticket_ref_key("c1", "PRX-1"), ticket_ref_key("c1", "PRX-2")];
        let run = compose_scheduled_run(None, input).expect("compose");
        assert!(!run.entries[0].with_previous);
        assert_eq!(steps_of(&run), vec![vec!["PRX-1", "PRX-2"]]);
        let first = run.entries[0].id.clone();
        let removed = remove_entry_from_scheduled_run(run, &first, NOW).expect("remove");
        assert!(!removed.entries[0].with_previous);
        assert_eq!(steps_of(&removed), vec![vec!["PRX-2"]]);
    }

    #[test]
    fn changing_only_which_tickets_run_together_is_an_edit_that_keeps_entry_ids() {
        let first = compose_scheduled_run(
            None,
            form(vec![ticket("PRX-1"), ticket("PRX-2"), ticket("PRX-3")]),
        )
        .expect("first");
        let mut grouped_form = form(vec![ticket("PRX-1"), ticket("PRX-2"), ticket("PRX-3")]);
        grouped_form.at = "2026-10-20T11:00:00.000Z".into();
        grouped_form.with_previous = vec![ticket_ref_key("c1", "PRX-3")];
        let grouped = compose_scheduled_run(Some(first.clone()), grouped_form).expect("group");
        assert_ne!(grouped, first);
        assert_eq!(
            grouped
                .entries
                .iter()
                .map(|e| e.id.clone())
                .collect::<Vec<_>>(),
            first
                .entries
                .iter()
                .map(|e| e.id.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            steps_of(&grouped),
            vec![vec!["PRX-1"], vec!["PRX-2", "PRX-3"]]
        );
        assert!(
            grouped
                .events
                .last()
                .is_some_and(|e| e.message.contains("PRX-2 + PRX-3"))
        );
        let ungrouped = compose_scheduled_run(
            Some(grouped.clone()),
            form(vec![ticket("PRX-1"), ticket("PRX-2"), ticket("PRX-3")]),
        )
        .expect("ungroup");
        assert_eq!(
            steps_of(&ungrouped),
            vec![vec!["PRX-1"], vec!["PRX-2"], vec!["PRX-3"]]
        );
        assert_eq!(
            compose_scheduled_run(
                Some(ungrouped.clone()),
                form(vec![ticket("PRX-1"), ticket("PRX-2"), ticket("PRX-3")])
            )
            .expect("again"),
            ungrouped
        );
    }

    #[test]
    fn a_stored_run_keeps_its_steps_when_read_back() {
        let mut input = form(vec![ticket("PRX-1"), ticket("PRX-2")]);
        input.with_previous = vec![ticket_ref_key("c1", "PRX-2")];
        let run = compose_scheduled_run(None, input).expect("compose");
        let json = serde_json::to_string(&run).expect("serialize");
        let reread: ScheduledRun = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(steps_of(&reread), vec![vec!["PRX-1", "PRX-2"]]);
    }

    fn steps_of(run: &ScheduledRun) -> Vec<Vec<&str>> {
        scheduled_steps(&run.entries)
            .iter()
            .map(|step| step.iter().map(|e| e.ticket.issue_key.as_str()).collect())
            .collect()
    }
}
