//! How a scheduled run is likely to go, in time and spend (`scheduledRunForecast.ts` port).
//!
//! The forecast is built only from what this machine measured: how long each stage of the same
//! workflow took in earlier runs, and what those runs cost. With too few earlier runs there is no
//! time or spend forecast, and the screens say so instead of showing a number nobody measured.
//!
//! It applies the runner's own rules: steps in order, a step waits for every ticket before it, never
//! more than `max_concurrency` tickets at once. For a run already going it starts from what
//! happened: finished tickets keep their real times, a running ticket gets its remaining estimate
//! from now, and time spent waiting so far is already in the clock.

use chrono::DateTime;

use crate::ai_usage::AiUsageEvent;
use crate::edges::dag_edges;
use crate::run::{WorkflowRun, WorkflowRunStatus};
use crate::scheduled_run::{
    ScheduledRun, ScheduledRunStatus, scheduled_concurrency, scheduled_steps,
};
use crate::scheduled_run_detail::ordered_workflow_stages;
use crate::types::{WorkflowDefinition, WorkflowEdgeOutcome};

/// Fewer finished earlier runs of the workflow than this and a forecast would be a guess.
pub const MIN_FORECAST_RUNS: usize = 3;

/// How long one ticket takes and what it costs, from earlier runs of the same workflow.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ScheduledTicketEstimate {
    /// Seconds for one ticket: the median, and the slow end (90th percentile of each stage).
    pub duration_sec: Option<ScheduledDurationEstimate>,
    /// Cost of one ticket from earlier runs: median, 25th and 90th percentile.
    pub spend: Option<ScheduledSpendEstimate>,
    /// Finished earlier runs of this workflow the figures come from.
    pub based_on_runs: usize,
}

/// The time one ticket takes.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduledDurationEstimate {
    pub likely: f64,
    pub slow: f64,
}

/// What one ticket costs.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduledSpendEstimate {
    pub likely: f64,
    pub low: f64,
    pub high: f64,
    pub currency: String,
}

/// Where one ticket sits in the forecast.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduledForecastEntry {
    pub entry_id: String,
    /// The ticket, so a view whose entries have no stable id yet can match it.
    pub issue_key: String,
    pub start_at: String,
    pub end_at: String,
    /// 1-based lane the ticket runs (or ran) in.
    pub lane: u32,
    pub state: ScheduledForecastState,
}

/// What a ticket is doing, as far as the forecast knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledForecastState {
    Done,
    Running,
    Waiting,
    Skipped,
}

/// The forecast for a schedule.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduledRunForecast {
    /// The workflow's agent tasks in run order, for "each ticket runs".
    pub stages: Vec<ScheduledForecastStage>,
    pub likely_finish_at: Option<String>,
    /// The slow end: every remaining stage at its 90th percentile. Labelled "could run to", never a
    /// promise.
    pub slow_finish_at: Option<String>,
    pub entries: Vec<ScheduledForecastEntry>,
    /// The whole run's spend: what finished tickets reported plus the estimate for the rest.
    pub spend: Option<ScheduledSpendEstimate>,
    pub per_ticket: Option<ScheduledSpendEstimate>,
    pub based_on_runs: usize,
    /// Why there is no time forecast, when there is none.
    pub not_estimable: Option<String>,
}

/// One agent task of the workflow, for the forecast's list.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduledForecastStage {
    pub node_id: String,
    pub name: String,
    pub node_type: String,
}

fn percentile(values: &[f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((fraction * (sorted.len() as f64 - 1.0)).round() as isize)
        .clamp(0, sorted.len() as isize - 1) as usize;
    sorted[index]
}

/// Longest path through the workflow's forward edges, weighting each stage with `weight`.
fn longest_path(definition: &WorkflowDefinition, weight: impl Fn(&str) -> f64) -> f64 {
    let edges: Vec<_> = dag_edges(definition)
        .filter(|edge| edge.on != WorkflowEdgeOutcome::Failure)
        .collect();
    let mut memo: Vec<(String, f64)> = Vec::new();
    let mut visiting: Vec<String> = Vec::new();
    fn from(
        node_id: &str,
        edges: &[&crate::types::WorkflowEdge],
        memo: &mut Vec<(String, f64)>,
        visiting: &mut Vec<String>,
        weight: &impl Fn(&str) -> f64,
    ) -> f64 {
        if let Some((_, value)) = memo.iter().find(|(id, _)| id == node_id) {
            return *value;
        }
        if visiting.iter().any(|id| id == node_id) {
            return 0.0;
        }
        visiting.push(node_id.to_string());
        let next: Vec<f64> = edges
            .iter()
            .filter(|edge| edge.from == node_id)
            .map(|edge| from(&edge.to, edges, memo, visiting, weight))
            .collect();
        visiting.retain(|id| id != node_id);
        let value = weight(node_id)
            + next
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max)
                .max(0.0);
        memo.push((node_id.to_string(), value));
        value
    }
    definition
        .nodes
        .iter()
        .map(|node| from(&node.base().id, &edges, &mut memo, &mut visiting, &weight))
        .fold(0.0, f64::max)
}

/// What one ticket of this workflow takes, from earlier runs of it. `history` is every stored run;
/// only finished runs of the same workflow count.
#[must_use]
pub fn estimate_scheduled_ticket(
    definition: &WorkflowDefinition,
    history: &[WorkflowRun],
    usage: &[AiUsageEvent],
) -> ScheduledTicketEstimate {
    let finished: Vec<&WorkflowRun> = history
        .iter()
        .filter(|run| {
            run.workflow_id == definition.id && run.status == WorkflowRunStatus::Succeeded
        })
        .collect();
    let based_on_runs = finished.len();
    if based_on_runs < MIN_FORECAST_RUNS {
        return ScheduledTicketEstimate {
            based_on_runs,
            ..ScheduledTicketEstimate::default()
        };
    }

    let mut samples: Vec<(String, Vec<f64>)> = Vec::new();
    for run in &finished {
        for (node_id, state) in &run.nodes {
            // One stage's time in one run: every attempt it took, since a retry or a loop is part of
            // the cost.
            let mut seconds = 0.0;
            for attempt in &state.attempts {
                let Some(ended_at) = &attempt.ended_at else {
                    continue;
                };
                let started = DateTime::parse_from_rfc3339(&attempt.started_at).ok();
                let ended = DateTime::parse_from_rfc3339(ended_at).ok();
                if let (Some(started), Some(ended)) = (started, ended) {
                    seconds += (ended - started).num_milliseconds().max(0) as f64 / 1000.0;
                }
            }
            if seconds > 0.0 {
                match samples.iter_mut().find(|(id, _)| id == node_id) {
                    Some((_, list)) => list.push(seconds),
                    None => samples.push((node_id.clone(), vec![seconds])),
                }
            }
        }
    }
    let sample_of = |node_id: &str| -> Vec<f64> {
        samples
            .iter()
            .find(|(id, _)| id == node_id)
            .map(|(_, list)| list.clone())
            .unwrap_or_default()
    };
    let likely = longest_path(definition, |node_id| percentile(&sample_of(node_id), 0.5));
    let slow = longest_path(definition, |node_id| percentile(&sample_of(node_id), 0.9));

    let ids: Vec<&str> = finished.iter().map(|run| run.run_id.as_str()).collect();
    let mut costs: Vec<(String, f64, String)> = Vec::new();
    let mut mixed = false;
    for event in usage {
        let Some(run_id) = event.workflow_run_id.as_deref() else {
            continue;
        };
        if !ids.contains(&run_id) {
            continue;
        }
        let Some(cost) = &event.cost else {
            continue;
        };
        match costs.iter_mut().find(|(id, _, _)| id == run_id) {
            Some((_, amount, currency)) => {
                if currency != &cost.currency {
                    mixed = true;
                }
                *amount += cost.amount;
            }
            None => costs.push((run_id.to_string(), cost.amount, cost.currency.clone())),
        }
    }
    let amounts: Vec<f64> = costs.iter().map(|(_, amount, _)| *amount).collect();
    let currency = costs.first().map(|(_, _, currency)| currency.clone());
    let spend = match (&currency, mixed) {
        (Some(currency), false) if amounts.len() >= MIN_FORECAST_RUNS => {
            Some(ScheduledSpendEstimate {
                likely: percentile(&amounts, 0.5),
                low: percentile(&amounts, 0.25),
                high: percentile(&amounts, 0.9),
                currency: currency.clone(),
            })
        }
        _ => None,
    };

    ScheduledTicketEstimate {
        duration_sec: (likely > 0.0).then_some(ScheduledDurationEstimate {
            likely,
            slow: slow.max(likely),
        }),
        spend,
        based_on_runs,
    }
}

/// One ticket's place in the forecast.
struct Placed {
    entry_id: String,
    issue_key: String,
    start: i64,
    end: i64,
    lane: u32,
    state: ScheduledForecastState,
}

fn parse_millis(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|instant| instant.timestamp_millis())
        .unwrap_or(0)
}

/// Lays the run out in time, following the runner's own rules.
fn simulate(run: &ScheduledRun, origin: i64, now: i64, ticket_millis: i64) -> Vec<Placed> {
    let lanes = scheduled_concurrency(&run.policy) as usize;
    let lanes = lanes.max(1);
    let mut placed: Vec<Placed> = Vec::new();
    let mut step_start = origin;
    for step in scheduled_steps(&run.entries) {
        let mut free = vec![step_start; lanes];
        let mut step_end = step_start;
        let take = |preferred: Option<u32>, at: i64, free: &Vec<i64>| -> (usize, i64) {
            let lane = preferred
                .filter(|preferred| *preferred >= 1 && *preferred as usize <= lanes)
                .map_or(-1i64, |preferred| preferred as i64 - 1);
            let lane = if lane < 0 {
                let mut best = 0;
                for index in 1..lanes {
                    if free[index] < free[best] {
                        best = index;
                    }
                }
                best
            } else {
                lane as usize
            };
            (lane, free[lane].max(at))
        };
        // Tickets that already started keep their lane and time; the rest fill lanes after them.
        let mut ordered: Vec<&crate::scheduled_run::ScheduledQueueEntry> = step.clone();
        ordered.sort_by_key(|entry| {
            u8::from(
                !entry
                    .outcome
                    .as_ref()
                    .and_then(|outcome| outcome.started_at.as_ref())
                    .is_some(),
            )
        });
        for entry in ordered {
            let outcome = entry.outcome.clone();
            let status = outcome
                .as_ref()
                .map(|outcome| outcome.status)
                .unwrap_or(crate::scheduled_run::ScheduledEntryStatus::Queued);
            let started_at = outcome
                .as_ref()
                .and_then(|outcome| outcome.started_at.as_ref())
                .map(|started| parse_millis(started));
            let lane_of = outcome.as_ref().and_then(|outcome| outcome.lane);
            let ended_at = outcome
                .as_ref()
                .and_then(|outcome| outcome.ended_at.as_ref())
                .map(|ended| parse_millis(ended));
            if status == crate::scheduled_run::ScheduledEntryStatus::Skipped
                || (matches!(
                    status,
                    crate::scheduled_run::ScheduledEntryStatus::Done
                        | crate::scheduled_run::ScheduledEntryStatus::Failed
                ) && started_at.is_none())
            {
                let end = ended_at.unwrap_or(step_start);
                placed.push(Placed {
                    entry_id: entry.id.clone(),
                    issue_key: entry.ticket.issue_key.clone(),
                    start: end,
                    end,
                    lane: lane_of.unwrap_or(1),
                    state: ScheduledForecastState::Skipped,
                });
                continue;
            }
            if status == crate::scheduled_run::ScheduledEntryStatus::Done {
                let Some(start) = started_at else {
                    continue;
                };
                let end = ended_at.unwrap_or(now);
                let (lane, _) = take(lane_of, start, &free);
                free[lane] = free[lane].max(end);
                step_end = step_end.max(end);
                placed.push(Placed {
                    entry_id: entry.id.clone(),
                    issue_key: entry.ticket.issue_key.clone(),
                    start,
                    end,
                    lane: lane as u32 + 1,
                    state: ScheduledForecastState::Done,
                });
                continue;
            }
            if let Some(start) = started_at {
                // Running, waiting at a gate, or failed and waiting for a decision: the rest of its
                // estimate from now.
                let elapsed = (now - start).max(0);
                // A tenth of the estimate, never a negative: a ticket running well past its
                // estimate is given a little more, not a finish in the past.
                let remaining = (ticket_millis - elapsed).max(ticket_millis / 10);
                let end = now + remaining;
                let (lane, _) = take(lane_of, start, &free);
                free[lane] = free[lane].max(end);
                step_end = step_end.max(end);
                placed.push(Placed {
                    entry_id: entry.id.clone(),
                    issue_key: entry.ticket.issue_key.clone(),
                    start,
                    end,
                    lane: lane as u32 + 1,
                    state: ScheduledForecastState::Running,
                });
                continue;
            }
            let (lane, start) = take(None, step_start.max(now), &free);
            let end = start + ticket_millis;
            free[lane] = end;
            step_end = step_end.max(end);
            placed.push(Placed {
                entry_id: entry.id.clone(),
                issue_key: entry.ticket.issue_key.clone(),
                start,
                end,
                lane: lane as u32 + 1,
                state: ScheduledForecastState::Waiting,
            });
        }
        step_start = step_end;
    }
    placed
}

fn to_iso(millis: i64) -> String {
    DateTime::from_timestamp_millis(millis)
        .unwrap_or(DateTime::UNIX_EPOCH)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The forecast for a schedule. `now` is the clock; a schedule that has not started is forecast
/// from its own start time (or from now, when that has passed).
#[must_use]
pub fn forecast_scheduled_run(
    run: &ScheduledRun,
    estimate: &ScheduledTicketEstimate,
    definition: Option<&WorkflowDefinition>,
    now: &str,
) -> ScheduledRunForecast {
    let stages = definition
        .map(|definition| {
            ordered_workflow_stages(definition, |_| false)
                .into_iter()
                .map(|node| ScheduledForecastStage {
                    node_id: node.base().id.clone(),
                    name: node.base().name.clone(),
                    node_type: node.type_name().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let mut forecast = ScheduledRunForecast {
        stages,
        likely_finish_at: None,
        slow_finish_at: None,
        entries: Vec::new(),
        spend: None,
        per_ticket: estimate.spend.clone(),
        based_on_runs: estimate.based_on_runs,
        not_estimable: None,
    };

    let remaining_tickets = run
        .entries
        .iter()
        .filter(|entry| {
            !matches!(
                entry
                    .outcome
                    .as_ref()
                    .map(|outcome| outcome.status)
                    .unwrap_or(crate::scheduled_run::ScheduledEntryStatus::Queued),
                crate::scheduled_run::ScheduledEntryStatus::Done
                    | crate::scheduled_run::ScheduledEntryStatus::Failed
                    | crate::scheduled_run::ScheduledEntryStatus::Skipped
            )
        })
        .count();
    if let Some(per_ticket) = &estimate.spend {
        let reported: f64 = run
            .entries
            .iter()
            .map(|entry| {
                let outcome = entry.outcome.as_ref();
                let finished = matches!(
                    outcome.map(|outcome| outcome.status),
                    Some(crate::scheduled_run::ScheduledEntryStatus::Done)
                        | Some(crate::scheduled_run::ScheduledEntryStatus::Failed)
                        | Some(crate::scheduled_run::ScheduledEntryStatus::Skipped)
                );
                if finished {
                    outcome
                        .and_then(|outcome| outcome.spend.as_ref())
                        .and_then(|spend| spend.cost)
                        .unwrap_or(0.0)
                } else {
                    0.0
                }
            })
            .sum();
        forecast.spend = Some(ScheduledSpendEstimate {
            likely: reported + remaining_tickets as f64 * per_ticket.likely,
            low: reported + remaining_tickets as f64 * per_ticket.low,
            high: reported + remaining_tickets as f64 * per_ticket.high,
            currency: per_ticket.currency.clone(),
        });
    }

    let Some(duration) = &estimate.duration_sec else {
        forecast.not_estimable = Some(if estimate.based_on_runs < MIN_FORECAST_RUNS {
            format!(
                "Needs {MIN_FORECAST_RUNS} finished runs of this workflow to forecast; {}.",
                if estimate.based_on_runs == 0 {
                    "none yet".to_string()
                } else {
                    format!("{} so far", estimate.based_on_runs)
                }
            )
        } else {
            "Earlier runs of this workflow recorded no stage times.".to_string()
        });
        return forecast;
    };
    if run.entries.is_empty() {
        return forecast;
    }

    let clock = parse_millis(now);
    let attempt = run.attempts.last();
    let started = matches!(
        run.status,
        ScheduledRunStatus::Running
            | ScheduledRunStatus::Paused
            | ScheduledRunStatus::Completed
            | ScheduledRunStatus::Cancelled
            | ScheduledRunStatus::Failed
    ) && attempt.is_some();
    let origin = if started {
        parse_millis(&attempt.expect("attempt").started_at)
    } else {
        parse_millis(&run.scheduled_start_at).max(clock)
    };
    let effective_now = if started { clock } else { origin };
    let likely = simulate(
        run,
        origin,
        effective_now,
        (duration.likely * 1000.0) as i64,
    );
    let slow = simulate(run, origin, effective_now, (duration.slow * 1000.0) as i64);
    let finish = |placed: &[Placed]| {
        to_iso(
            placed
                .iter()
                .fold(origin, |latest, row| latest.max(row.end)),
        )
    };
    forecast.likely_finish_at = Some(finish(&likely));
    forecast.slow_finish_at = Some(finish(&slow));
    forecast.entries = likely
        .into_iter()
        .map(|row| ScheduledForecastEntry {
            entry_id: row.entry_id,
            issue_key: row.issue_key,
            start_at: to_iso(row.start),
            end_at: to_iso(row.end),
            lane: row.lane,
            state: row.state,
        })
        .collect();
    forecast
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::scheduled_run::{
        CreateScheduledRunInput, ScheduledEntrySpend, ScheduledTicketRef, create_scheduled_run,
        ticket_ref_key,
    };

    /// The shape of Governed delivery: a join, a parallel security branch, a failure-only repair
    /// stage. Declared out of order on purpose: the display order comes from the edges.
    fn governed() -> WorkflowDefinition {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "id": "governed",
            "name": "Governed delivery",
            "scope": "project",
            "version": 1,
            "entryNodeId": "plan",
            "createdAt": "2026-11-01T00:00:00.000Z",
            "updatedAt": "2026-11-01T00:00:00.000Z",
            "nodes": [
                { "id": "review", "name": "Review", "type": "agent-task", "x": 0, "y": 360, "inputs": [], "outputs": [], "instructions": "Review", "mutatesWorktree": false, "agent": { "agentId": "test-agent", "scope": "global", "toolMode": "read-only" } },
                { "id": "plan", "name": "Plan", "type": "agent-task", "x": 0, "y": 40, "inputs": [], "outputs": [], "instructions": "Plan", "mutatesWorktree": false, "agent": { "agentId": "test-agent", "scope": "global", "toolMode": "read-only" } },
                { "id": "implement", "name": "Implement", "type": "agent-task", "x": 0, "y": 200, "inputs": [], "outputs": [], "instructions": "Implement", "mutatesWorktree": false, "agent": { "agentId": "test-agent", "scope": "global", "toolMode": "read-only" } },
                { "id": "install", "name": "Install", "type": "check", "x": 40, "y": 680, "inputs": [], "outputs": [], "command": "npm", "args": ["run", "install"], "successExitCodes": [0] },
                { "id": "security", "name": "Security scan", "type": "check", "x": 280, "y": 680, "inputs": [], "outputs": [], "command": "npm", "args": ["run", "security"], "successExitCodes": [0] },
                { "id": "qa", "name": "QA", "type": "check", "x": 40, "y": 840, "inputs": [], "outputs": [], "command": "npm", "args": ["run", "qa"], "successExitCodes": [0] },
                { "id": "repair", "name": "Repair QA failures", "type": "agent-task", "x": 280, "y": 1000, "inputs": [], "outputs": [], "instructions": "Repair", "mutatesWorktree": false, "agent": { "agentId": "test-agent", "scope": "global", "toolMode": "read-only" } },
                { "id": "gates", "name": "Gates", "type": "join", "x": 160, "y": 1160, "inputs": [], "mode": "all" },
                { "id": "approve", "name": "Approve", "type": "approval", "x": 160, "y": 1320, "inputs": [], "prompt": "Ship?", "requiredGates": [], "allowBypass": false }
            ],
            "edges": [
                { "id": "a", "from": "plan", "to": "implement", "on": "success", "required": true },
                { "id": "b", "from": "implement", "to": "review", "on": "success", "required": true },
                { "id": "c", "from": "review", "to": "install", "on": "success", "required": true },
                { "id": "d", "from": "review", "to": "security", "on": "success", "required": true },
                { "id": "e", "from": "install", "to": "qa", "on": "success", "required": true },
                { "id": "f", "from": "qa", "to": "repair", "on": "failure", "required": false },
                { "id": "g", "from": "qa", "to": "gates", "on": "success", "required": true },
                { "id": "h", "from": "security", "to": "gates", "on": "success", "required": true },
                { "id": "i", "from": "gates", "to": "approve", "on": "success", "required": true }
            ]
        }))
        .expect("definition")
    }

    /// A finished run of the governed workflow, with each stage taking `seconds`.
    fn finished_run(run_id: &str, seconds: &[(&str, u64)]) -> WorkflowRun {
        let definition = governed();
        let mut clock = DateTime::parse_from_rfc3339("2026-10-01T00:00:00.000Z")
            .expect("clock")
            .timestamp_millis();
        let mut nodes: indexmap::IndexMap<String, crate::run::WorkflowNodeState> =
            indexmap::IndexMap::new();
        for (node_id, seconds) in seconds {
            let started_at = to_iso(clock);
            clock += (*seconds as i64) * 1000;
            let ended_at = to_iso(clock);
            nodes.insert(
                (*node_id).to_string(),
                serde_json::from_value(serde_json::json!({
                    "nodeId": node_id,
                    "outcome": "succeeded",
                    "attempts": [{
                        "attempt": 1,
                        "outcome": "succeeded",
                        "startedAt": started_at,
                        "endedAt": ended_at
                    }],
                    "artifacts": []
                }))
                .expect("node state"),
            );
        }
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "runId": run_id,
            "workflowId": "governed",
            "workflowVersion": 1,
            "projectId": "p",
            "status": "succeeded",
            "definition": definition,
            "nodes": nodes,
            "events": [],
            "gateDecisions": [],
            "startedAt": "2026-10-01T00:00:00.000Z"
        }))
        .expect("run")
    }

    fn history() -> Vec<WorkflowRun> {
        vec![
            finished_run(
                "h1",
                &[
                    ("plan", 100),
                    ("implement", 200),
                    ("review", 40),
                    ("install", 10),
                    ("security", 5),
                    ("qa", 300),
                ],
            ),
            finished_run(
                "h2",
                &[
                    ("plan", 120),
                    ("implement", 260),
                    ("review", 50),
                    ("install", 12),
                    ("security", 5),
                    ("qa", 320),
                ],
            ),
            finished_run(
                "h3",
                &[
                    ("plan", 140),
                    ("implement", 900),
                    ("review", 60),
                    ("install", 14),
                    ("security", 5),
                    ("qa", 340),
                ],
            ),
        ]
    }

    fn cost(run_id: &str, amount: f64) -> AiUsageEvent {
        AiUsageEvent {
            id: run_id.to_string(),
            timestamp: "2026-10-01T00:00:00.000Z".to_string(),
            source: crate::ai_usage::AiUsageSource::WorkflowRecommendation,
            session_id: None,
            provider: None,
            model: None,
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            cost: Some(crate::ai_usage::AiUsageCost {
                amount,
                currency: "USD".to_string(),
            }),
            workflow_run_id: Some(run_id.to_string()),
            workflow_node_id: None,
        }
    }

    fn schedule(steps: &[&[&str]], lanes: i64) -> ScheduledRun {
        let tickets: Vec<ScheduledTicketRef> = steps
            .iter()
            .flat_map(|step| step.iter())
            .map(|key| ScheduledTicketRef {
                connection_id: "c".into(),
                issue_key: (*key).into(),
                title: (*key).into(),
            })
            .collect();
        let with_previous: Vec<String> = steps
            .iter()
            .flat_map(|step| step.iter().skip(1))
            .map(|key| ticket_ref_key("c", key))
            .collect();
        create_scheduled_run(CreateScheduledRunInput {
            id: None,
            project_id: None,
            name: "Night".into(),
            scheduled_start_at: "2026-11-03T22:00:00.000Z".into(),
            timezone: "UTC".into(),
            tickets,
            with_previous,
            workflow_id: Some("governed".into()),
            max_concurrency: Some(lanes),
            at: "2026-11-02T10:00:00.000Z".into(),
        })
        .expect("run")
    }

    fn estimate() -> ScheduledTicketEstimate {
        ScheduledTicketEstimate {
            duration_sec: Some(ScheduledDurationEstimate {
                likely: 600.0,
                slow: 1200.0,
            }),
            spend: Some(ScheduledSpendEstimate {
                likely: 4.0,
                low: 3.0,
                high: 7.0,
                currency: "USD".into(),
            }),
            based_on_runs: 5,
        }
    }

    #[test]
    fn a_ticket_estimate_needs_enough_finished_runs_of_the_same_workflow() {
        let estimate =
            estimate_scheduled_ticket(&governed(), &history()[..MIN_FORECAST_RUNS - 1], &[]);
        assert_eq!(estimate.based_on_runs, 2);
        assert!(estimate.duration_sec.is_none());
        assert!(estimate.spend.is_none());

        let other: Vec<WorkflowRun> = history()
            .into_iter()
            .map(|mut run| {
                run.workflow_id = "something-else".into();
                run
            })
            .collect();
        assert_eq!(
            estimate_scheduled_ticket(&governed(), &other, &[]).based_on_runs,
            0
        );
    }

    #[test]
    fn a_ticket_takes_its_stages_median_times_along_the_longest_path() {
        let estimate = estimate_scheduled_ticket(
            &governed(),
            &history(),
            &[
                cost("h1", 3.0),
                cost("h2", 4.0),
                cost("h2", 0.5),
                cost("h3", 6.0),
            ],
        );
        // plan 120 + implement 260 + review 50 + max(install 12 + qa 320, security 5) = 762
        let duration = estimate.duration_sec.expect("duration");
        assert_eq!(duration.likely, 762.0);
        assert!(duration.slow >= 762.0);
        let spend = estimate.spend.expect("spend");
        assert_eq!(spend.likely, 4.5);
        assert_eq!(spend.low, 4.5);
        assert_eq!(spend.high, 6.0);
        assert_eq!(spend.currency, "USD");
        assert_eq!(estimate.based_on_runs, 3);
    }

    #[test]
    fn a_sequential_schedule_runs_one_ticket_after_another_from_its_start_time() {
        let run = schedule(&[&["A"], &["B"], &["C"]], 1);
        let forecast = forecast_scheduled_run(
            &run,
            &estimate(),
            Some(&governed()),
            "2026-11-02T12:00:00.000Z",
        );
        assert_eq!(
            forecast.likely_finish_at.as_deref(),
            Some("2026-11-03T22:30:00.000Z")
        );
        assert_eq!(
            forecast.slow_finish_at.as_deref(),
            Some("2026-11-03T23:00:00.000Z")
        );
        assert_eq!(
            forecast
                .entries
                .iter()
                .map(|entry| entry.start_at[11..16].to_string())
                .collect::<Vec<_>>(),
            vec!["22:00", "22:10", "22:20"]
        );
        let spend = forecast.spend.expect("spend");
        assert_eq!(spend.likely, 12.0);
        assert_eq!(spend.low, 9.0);
        assert_eq!(spend.high, 21.0);
        assert_eq!(
            forecast
                .stages
                .iter()
                .map(|stage| stage.name.as_str())
                .collect::<Vec<_>>(),
            vec![
                "Plan",
                "Implement",
                "Review",
                "Install",
                "Security scan",
                "QA",
                "Approve"
            ]
        );
    }

    #[test]
    fn lanes_run_a_step_side_by_side_and_the_next_step_waits_for_all_of_it() {
        let run = schedule(&[&["A", "B", "C"], &["D"]], 2);
        let forecast = forecast_scheduled_run(
            &run,
            &estimate(),
            Some(&governed()),
            "2026-11-02T12:00:00.000Z",
        );
        let key_of = |entry: &ScheduledForecastEntry| {
            run.entries
                .iter()
                .find(|item| item.id == entry.entry_id)
                .map(|item| item.ticket.issue_key.clone())
                .unwrap_or_default()
        };
        let find = |key: &str| {
            forecast
                .entries
                .iter()
                .find(|entry| key_of(entry) == key)
                .expect("entry")
        };
        assert_eq!(&find("A").start_at[11..16], "22:00");
        assert_eq!(&find("B").start_at[11..16], "22:00");
        assert_eq!(&find("C").start_at[11..16], "22:10");
        assert_ne!(find("A").lane, find("B").lane);
        assert_eq!(&find("D").start_at[11..16], "22:20");
        assert_eq!(
            forecast.likely_finish_at.as_deref(),
            Some("2026-11-03T22:30:00.000Z")
        );
    }

    #[test]
    fn a_run_already_going_keeps_what_happened_and_forecasts_the_rest_from_now() {
        let mut run = schedule(&[&["A"], &["B"], &["C"]], 1);
        run.status = ScheduledRunStatus::Running;
        run.attempts = vec![crate::scheduled_run::ScheduledRunAttempt {
            id: "x".into(),
            trigger: crate::scheduled_run::ScheduledRunTrigger::Schedule,
            started_at: "2026-11-03T22:00:00.000Z".into(),
            ended_at: None,
        }];
        run.entries[0].outcome = Some(crate::scheduled_run::ScheduledEntryOutcome {
            status: crate::scheduled_run::ScheduledEntryStatus::Done,
            started_at: Some("2026-11-03T22:00:00.000Z".into()),
            ended_at: Some("2026-11-03T22:25:00.000Z".into()),
            spend: Some(ScheduledEntrySpend {
                cost: Some(5.0),
                currency: Some("USD".into()),
                ..ScheduledEntrySpend::default()
            }),
            ..crate::scheduled_run::ScheduledEntryOutcome::queued()
        });
        // Running well past its estimate: it is given a tenth of the estimate still to go, never a
        // negative.
        run.entries[1].outcome = Some(crate::scheduled_run::ScheduledEntryOutcome {
            status: crate::scheduled_run::ScheduledEntryStatus::Running,
            started_at: Some("2026-11-03T22:25:00.000Z".into()),
            ..crate::scheduled_run::ScheduledEntryOutcome::queued()
        });

        let forecast = forecast_scheduled_run(
            &run,
            &estimate(),
            Some(&governed()),
            "2026-11-03T22:45:00.000Z",
        );
        let entries = &forecast.entries;
        assert_eq!(entries[0].state, ScheduledForecastState::Done);
        assert_eq!(entries[0].end_at, "2026-11-03T22:25:00.000Z");
        assert_eq!(entries[1].state, ScheduledForecastState::Running);
        assert_eq!(entries[1].end_at, "2026-11-03T22:46:00.000Z");
        assert_eq!(entries[2].state, ScheduledForecastState::Waiting);
        assert_eq!(entries[2].start_at, "2026-11-03T22:46:00.000Z");
        assert_eq!(
            forecast.likely_finish_at.as_deref(),
            Some("2026-11-03T22:56:00.000Z")
        );
        // Finished tickets count what they reported; the rest the per-ticket estimate.
        assert_eq!(forecast.spend.expect("spend").likely, 13.0);
    }

    #[test]
    fn with_nothing_measured_there_is_no_time_forecast_and_it_says_why() {
        let forecast = forecast_scheduled_run(
            &schedule(&[&["A"]], 1),
            &ScheduledTicketEstimate {
                based_on_runs: 1,
                ..ScheduledTicketEstimate::default()
            },
            Some(&governed()),
            "2026-11-02T12:00:00.000Z",
        );
        assert!(forecast.likely_finish_at.is_none());
        assert!(forecast.entries.is_empty());
        assert!(
            forecast
                .not_estimable
                .as_deref()
                .unwrap_or_default()
                .contains("Needs 3 finished runs of this workflow to forecast; 1 so far"),
            "{:?}",
            forecast.not_estimable
        );
        assert_eq!(forecast.stages.len(), 7);
    }

    #[test]
    fn the_stages_are_in_run_order_without_the_join_and_a_repair_step_only_once_it_has_run() {
        let definition = governed();
        let ordered = ordered_workflow_stages(&definition, |_| false);
        let names: Vec<&str> = ordered
            .iter()
            .map(|node| node.base().name.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "Plan",
                "Implement",
                "Review",
                "Install",
                "Security scan",
                "QA",
                "Approve"
            ]
        );
        let with_repair = ordered_workflow_stages(&definition, |node_id| node_id == "repair");
        assert!(with_repair.iter().any(|node| node.base().id == "repair"));
    }
}
