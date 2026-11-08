//! Deterministic workflow scheduler (`workflowScheduler.ts` port, FX-BE-019).
//!
//! Pure: given a run, decide what may start now. Two rules do the real work: only joins
//! wait on several branches, and at most one mutating stage runs at a time.

use serde::{Deserialize, Serialize};

use crate::edges::{
    EdgeState, PendingLoopKind, awaiting_skeptic, dag_edges, describe_findings_predicate,
    edge_state_for, pending_loop,
};
use crate::providers::provider_display_name;
use crate::run::{
    WorkflowPauseReason, WorkflowRun, WorkflowRunCommand, WorkflowRunStatus, apply_command,
    is_paused_node, is_run_settled, pause_reason_of,
};
use crate::types::{
    JoinMode, WorkflowEdge, WorkflowEdgeOutcome, WorkflowNode, WorkflowNodeOutcome,
};

/// A node that can never run, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledSkip {
    pub node_id: String,
    pub reason: String,
}

/// What may move now.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSchedule {
    /// Nodes that may start now, in definition order.
    pub ready: Vec<String>,
    /// Join nodes whose branches have converged.
    pub auto_advance: Vec<String>,
    /// Nodes whose branch was not taken and can never run.
    pub skip: Vec<ScheduledSkip>,
    /// Approval nodes whose turn it is, waiting on a human.
    pub awaiting_approval: Vec<String>,
    /// Nodes currently in flight.
    pub running: Vec<String>,
    /// Why nothing is ready, for a genuine stall only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

fn node_name(run: &WorkflowRun, id: &str) -> String {
    run.definition
        .node(id)
        .map_or_else(|| id.to_string(), |n| n.name().to_string())
}

/// Decides what may start now.
#[must_use]
pub fn schedule_workflow_run(run: &WorkflowRun) -> WorkflowSchedule {
    let running: Vec<String> = run
        .nodes
        .values()
        .filter(|s| s.outcome == WorkflowNodeOutcome::Running)
        .map(|s| s.node_id.clone())
        .collect();

    if is_run_settled(run) {
        return WorkflowSchedule {
            running,
            ..WorkflowSchedule::default()
        };
    }

    // A firing loop edge decides where the run goes next; nothing new starts meanwhile.
    if let Some((kind, status)) = pending_loop(run) {
        let from = node_name(run, &status.edge.from);
        let to = node_name(run, &status.edge.to);
        let why = if status.edge.on == WorkflowEdgeOutcome::Findings {
            format!(
                " ({})",
                describe_findings_predicate(status.edge.when.as_ref(), run.parameters.as_ref())
            )
        } else {
            String::new()
        };
        let blocked = (running.is_empty() || kind == PendingLoopKind::Decide).then(|| {
            if kind == PendingLoopKind::Decide {
                format!(
                    "Needs a decision: {from} still matches its loop back to {to}{why} after {} of {} iterations.",
                    status.iterations_taken, status.budget
                )
            } else {
                format!("Looping back from {from} to {to}{why}.")
            }
        });
        return WorkflowSchedule {
            running,
            blocked,
            ..WorkflowSchedule::default()
        };
    }

    let mut ready = Vec::new();
    let mut auto_advance = Vec::new();
    let mut skip = Vec::new();
    let mut awaiting_approval = Vec::new();

    // Definition order, so a given run state always schedules identically.
    for node in &run.definition.nodes {
        let Some(state) = run.nodes.get(node.id()) else {
            continue;
        };
        if state.outcome != WorkflowNodeOutcome::Pending {
            continue;
        }
        match evaluate(run, node) {
            Verdict::Skip(reason) => skip.push(ScheduledSkip {
                node_id: node.id().to_string(),
                reason,
            }),
            Verdict::Wait => {}
            Verdict::Ready => match node {
                // An approval is ready for a person, not for the orchestrator.
                WorkflowNode::Approval(_) => awaiting_approval.push(node.id().to_string()),
                WorkflowNode::Join(_) => auto_advance.push(node.id().to_string()),
                _ => ready.push(node.id().to_string()),
            },
        }
    }

    let admitted = admit(run, &ready, &running);
    let blocked = (admitted.is_empty()
        && auto_advance.is_empty()
        && running.is_empty()
        && awaiting_approval.is_empty())
    .then(|| describe_stall(run, &ready));
    WorkflowSchedule {
        ready: admitted,
        auto_advance,
        skip,
        awaiting_approval,
        running,
        blocked,
    }
}

/// Settles every converged join — and every node on a branch that can no longer be
/// taken — repeatedly, until none remain.
#[must_use]
pub fn advance_joins(run: WorkflowRun, at: &str) -> WorkflowRun {
    let mut next = run;
    // Bounded by node count: each pass settles at least one node for good.
    for _ in 0..next.definition.nodes.len() {
        let schedule = schedule_workflow_run(&next);
        // A branch closed by a failure stays pending: a person can retry the failed stage.
        let skip: Vec<ScheduledSkip> = schedule
            .skip
            .into_iter()
            .filter(|s| {
                !next.definition.edges.iter().any(|edge| {
                    edge.to == s.node_id
                        && next
                            .nodes
                            .get(&edge.from)
                            .is_some_and(|st| st.outcome == WorkflowNodeOutcome::Failed)
                })
            })
            .collect();
        if schedule.auto_advance.is_empty() && skip.is_empty() {
            return next;
        }
        for node_id in schedule.auto_advance {
            next = apply_command(
                next,
                &WorkflowRunCommand::NodeStarted {
                    node_id: node_id.clone(),
                    at: at.to_string(),
                    session_id: None,
                },
            );
            next = apply_command(
                next,
                &WorkflowRunCommand::NodeSucceeded {
                    node_id,
                    at: at.to_string(),
                    artifacts: None,
                    exit_code: None,
                    snapshot_ref: None,
                    assessed_snapshot_ref: None,
                    findings: None,
                    provider: None,
                    model: None,
                    independence: None,
                    map_items: None,
                },
            );
        }
        for ScheduledSkip { node_id, reason } in skip {
            next = apply_command(
                next,
                &WorkflowRunCommand::NodeSkipped {
                    node_id,
                    at: at.to_string(),
                    reason,
                },
            );
        }
    }
    next
}

/// The status a run should be showing, derived from what can move.
#[must_use]
pub fn derive_run_status(run: &WorkflowRun) -> WorkflowRunStatus {
    if is_run_settled(run) {
        return run.status;
    }
    let schedule = schedule_workflow_run(run);
    let stalled = schedule.ready.is_empty()
        && schedule.auto_advance.is_empty()
        && schedule.running.is_empty();
    if stalled && !schedule.awaiting_approval.is_empty() {
        WorkflowRunStatus::AwaitingApproval
    } else {
        WorkflowRunStatus::Running
    }
}

/// Read-only stages all pass; mutating stages queue behind whatever is already writing,
/// and only the first in definition order is admitted per pass.
fn admit(run: &WorkflowRun, ready: &[String], running: &[String]) -> Vec<String> {
    let mutating = |id: &str| {
        run.definition
            .node(id)
            .is_some_and(WorkflowNode::mutates_worktree)
    };
    let mut claimed = running.iter().any(|id| mutating(id));
    let mut admitted = Vec::new();
    for id in ready {
        if !mutating(id) {
            admitted.push(id.clone());
        } else if !claimed {
            claimed = true;
            admitted.push(id.clone());
        }
    }
    admitted
}

enum Verdict {
    Ready,
    Wait,
    Skip(String),
}

fn evaluate(run: &WorkflowRun, node: &WorkflowNode) -> Verdict {
    // Loop edges are not inbound branches.
    let inbound: Vec<&WorkflowEdge> = dag_edges(&run.definition)
        .filter(|e| e.to == node.id())
        .collect();
    if inbound.is_empty() {
        return Verdict::Ready;
    }
    let states: Vec<(&WorkflowEdge, EdgeState)> = inbound
        .iter()
        .map(|edge| (*edge, edge_state(run, edge)))
        .collect();

    if let WorkflowNode::Join(join) = node {
        // `all-required` ignores advisory branches entirely.
        let considered: Vec<&(&WorkflowEdge, EdgeState)> = states
            .iter()
            .filter(|(edge, _)| join.mode != JoinMode::AllRequired || edge.required)
            .collect();
        if let Some((edge, _)) = considered.iter().find(|(_, s)| *s == EdgeState::Dead) {
            return Verdict::Skip(format!(
                "branch from \"{}\" did not reach this join",
                edge.from
            ));
        }
        if considered.iter().any(|(_, s)| *s == EdgeState::Waiting) {
            return Verdict::Wait;
        }
        return Verdict::Ready;
    }

    if states.iter().any(|(_, s)| *s == EdgeState::Satisfied) {
        return Verdict::Ready;
    }
    if states.iter().any(|(_, s)| *s == EdgeState::Waiting) {
        return Verdict::Wait;
    }
    Verdict::Skip(format!(
        "no inbound branch from \"{}\" was taken",
        inbound[0].from
    ))
}

fn edge_state(run: &WorkflowRun, edge: &WorkflowEdge) -> EdgeState {
    // A findings edge waits for any skeptic of its source to deliver its verdicts.
    let source_settled = run
        .nodes
        .get(&edge.from)
        .is_some_and(|s| s.outcome.is_terminal());
    if edge.on == WorkflowEdgeOutcome::Findings
        && source_settled
        && awaiting_skeptic(run, &edge.from)
    {
        return EdgeState::Waiting;
    }
    let recovery_exhausted = match run.definition.node(&edge.from) {
        Some(WorkflowNode::Check(check)) => check
            .failure_recovery
            .as_ref()
            .filter(|recovery| recovery.repair_node_id == edge.to)
            .map(|recovery| {
                let used = run
                    .recovery_attempts
                    .as_ref()
                    .and_then(|attempts| attempts.get(&check.base.id))
                    .copied()
                    .unwrap_or(0);
                used >= recovery.max_attempts
            }),
        _ => None,
    };
    edge_state_for(
        edge,
        run.nodes.get(&edge.from),
        recovery_exhausted,
        run.parameters.as_ref(),
    )
}

/// Names the reason a run has stalled, so the monitor can offer the right action.
fn describe_stall(run: &WorkflowRun, ready_before_admission: &[String]) -> String {
    if !ready_before_admission.is_empty() {
        return "Waiting for the implementation worktree to free up.".to_string();
    }

    let paused: Vec<_> = run.nodes.values().filter(|s| is_paused_node(s)).collect();
    if !paused.is_empty() {
        let mut ids: Vec<&str> = paused.iter().map(|s| s.node_id.as_str()).collect();
        ids.sort_unstable();
        let mut ais: Vec<&str> = Vec::new();
        for state in &paused {
            if let Some(provider) = state
                .attempts
                .last()
                .and_then(|a| a.provider.as_deref())
                .filter(|p| !p.is_empty())
                && !ais.contains(&provider)
            {
                ais.push(provider);
            }
        }
        let who = if ais.is_empty() {
            "the AI provider".to_string()
        } else {
            ais.iter()
                .map(|p| provider_display_name(p))
                .collect::<Vec<_>>()
                .join(" and ")
        };
        let ids = ids.join(", ");
        return if paused
            .iter()
            .all(|s| pause_reason_of(s) == Some(WorkflowPauseReason::ProviderLimit))
        {
            format!(
                "Paused: {who} ran out of credits or hit its usage limit at {ids}. Switch to another AI, or restore them and retry."
            )
        } else {
            format!("Paused: {ids} could not run in this environment. Fix that, then retry.")
        };
    }

    let mut failed: Vec<&str> = run
        .nodes
        .values()
        .filter(|s| s.outcome == WorkflowNodeOutcome::Failed)
        .map(|s| s.node_id.as_str())
        .collect();
    if !failed.is_empty() {
        failed.sort_unstable();
        return format!(
            "Blocked on failed {}: {}.",
            if failed.len() == 1 { "stage" } else { "stages" },
            failed.join(", ")
        );
    }

    let unfinished = run
        .nodes
        .values()
        .filter(|s| !s.outcome.is_terminal())
        .count();
    if unfinished == 0 {
        "Every stage has settled.".to_string()
    } else {
        format!("No stage can start; {unfinished} left unreachable.")
    }
}
