//! Timeout, cancellation, and restart recovery (`workflowRecovery.ts` port, FX-BE-019).
//!
//! A completed stage is never done twice. Recovery closes attempts that were in flight
//! when the process died — it does not resume them — and surfaces an explicit retry.

use chrono::{DateTime, Utc};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::gates::{GateState, evaluate_gates};
use crate::run::{
    WorkflowRun, WorkflowRunCommand, WorkflowRunStatus, apply_command, attempts_spent,
    is_run_settled, label, merge_conflict_of,
};
use crate::scheduler::schedule_workflow_run;
use crate::stage_session::find_snapshot;
use crate::types::{WorkflowArtifactKind, WorkflowNode, WorkflowNodeOutcome};
use crate::waivers::parse_iso_date;

/// Result of [`recover_workflow_run`].
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowRecoveryResult {
    pub run: WorkflowRun,
    /// Attempts that were in flight when the app stopped.
    pub interrupted: Vec<String>,
}

/// Reconciles a run loaded from storage against a process restart. Completed nodes are
/// left exactly as they are.
#[must_use]
pub fn recover_workflow_run(run: WorkflowRun, at: &str) -> WorkflowRecoveryResult {
    let running: Vec<String> = run
        .nodes
        .values()
        .filter(|s| s.outcome == WorkflowNodeOutcome::Running)
        .map(|s| s.node_id.clone())
        .collect();
    if is_run_settled(&run) {
        // A finished run still showing stages as running is repaired, not left spinning.
        let mut repaired = run;
        for node_id in running {
            repaired = apply_command(
                repaired,
                &WorkflowRunCommand::NodeStopped {
                    node_id,
                    at: at.to_string(),
                    reason: Some("the run had already ended.".to_string()),
                },
            );
        }
        return WorkflowRecoveryResult {
            run: repaired,
            interrupted: Vec::new(),
        };
    }
    let mut interrupted = running;
    interrupted.sort();
    let mut next = run;
    for node_id in &interrupted {
        next = apply_command(
            next,
            &WorkflowRunCommand::NodeInterrupted {
                node_id: node_id.clone(),
                at: at.to_string(),
            },
        );
    }
    WorkflowRecoveryResult {
        run: next,
        interrupted,
    }
}

/// Nodes whose in-flight attempt has outrun its timeout. Returned rather than applied so
/// the caller stops the underlying session first.
#[must_use]
pub fn find_timed_out_nodes(run: &WorkflowRun, now: &str) -> Vec<String> {
    let Some(now) = parse_iso_date(now) else {
        return Vec::new();
    };
    let mut timed_out: Vec<String> = run
        .nodes
        .values()
        .filter(|state| state.outcome == WorkflowNodeOutcome::Running)
        .filter(|state| {
            let Some(timeout) = run
                .definition
                .node(&state.node_id)
                .filter(|node| !matches!(node, WorkflowNode::Map(_)))
                .and_then(WorkflowNode::timeout_ms)
                .filter(|t| *t > 0)
            else {
                return false;
            };
            state
                .attempts
                .last()
                .and_then(|attempt| parse_iso_date(&attempt.started_at))
                .is_some_and(|started: DateTime<Utc>| {
                    i128::from((now - started).num_milliseconds()) > i128::from(timeout)
                })
        })
        .map(|state| state.node_id.clone())
        .collect();
    timed_out.sort();
    timed_out
}

/// Something a person can do with a run right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WorkflowNextAction {
    #[serde(rename_all = "camelCase")]
    StartStage {
        node_id: String,
        label: String,
    },
    #[serde(rename_all = "camelCase")]
    RetryStage {
        node_id: String,
        label: String,
        attempts_used: usize,
        max_attempts: u32,
    },
    #[serde(rename_all = "camelCase")]
    ReworkStage {
        node_id: String,
        label: String,
    },
    #[serde(rename = "resolve-merge-with-ai", rename_all = "camelCase")]
    ResolveMergeWithAi {
        node_id: String,
        label: String,
        files: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Approve {
        node_id: String,
        label: String,
    },
    #[serde(rename_all = "camelCase")]
    SkipApproval {
        node_id: String,
        label: String,
    },
    CancelRun {
        label: String,
    },
    None {
        label: String,
    },
}

impl WorkflowNextAction {
    fn node_id(&self) -> Option<&str> {
        match self {
            Self::StartStage { node_id, .. }
            | Self::RetryStage { node_id, .. }
            | Self::ReworkStage { node_id, .. }
            | Self::ResolveMergeWithAi { node_id, .. }
            | Self::Approve { node_id, .. }
            | Self::SkipApproval { node_id, .. } => Some(node_id),
            Self::CancelRun { .. } | Self::None { .. } => None,
        }
    }
}

fn retry_actions(run: &WorkflowRun) -> Vec<WorkflowNextAction> {
    run.nodes
        .values()
        .filter(|s| s.outcome == WorkflowNodeOutcome::Failed)
        .map(|state| WorkflowNextAction::RetryStage {
            node_id: state.node_id.clone(),
            label: format!("Retry {}", label(run, &state.node_id)),
            attempts_used: attempts_spent(state),
            max_attempts: run
                .definition
                .node(&state.node_id)
                .and_then(WorkflowNode::max_attempts)
                .unwrap_or(1),
        })
        .collect()
}

fn rework_actions(run: &WorkflowRun, now: Option<DateTime<Utc>>) -> Vec<WorkflowNextAction> {
    // source stage → (failed gates, stale gates), in first-seen order.
    let mut sources: IndexMap<String, (Vec<&'static str>, Vec<&'static str>)> = IndexMap::new();
    for node in &run.definition.nodes {
        if !matches!(node, WorkflowNode::Approval(_)) {
            continue;
        }
        for gate in evaluate_gates(run, node.id(), None, None, now) {
            let Some(gate_node) = gate.node_id.as_deref() else {
                continue;
            };
            if gate.state != GateState::Stale && gate.state != GateState::Failed {
                continue;
            }
            let Some(source) = find_snapshot(run, gate_node).map(|s| s.produced_by_node_id) else {
                continue;
            };
            let entry = sources.entry(source).or_default();
            let target = if gate.state == GateState::Failed {
                &mut entry.0
            } else {
                &mut entry.1
            };
            if !target.contains(&gate.gate.as_str()) {
                target.push(gate.gate.as_str());
            }
        }
    }
    sources
        .into_iter()
        .map(|(node_id, (failed, stale))| {
            let mut parts = Vec::new();
            if !failed.is_empty() {
                parts.push(format!("{} failed", failed.join(", ")));
            }
            if !stale.is_empty() {
                parts.push(format!("{} stale", stale.join(", ")));
            }
            WorkflowNextAction::ReworkStage {
                label: format!(
                    "Start a new revision from {} ({})",
                    label(run, &node_id),
                    parts.join(", ")
                ),
                node_id,
            }
        })
        .collect()
}

/// A failure further on can come from an unsound plan; offer to plan again.
fn replan_actions(run: &WorkflowRun, existing: &[WorkflowNextAction]) -> Vec<WorkflowNextAction> {
    let Some(WorkflowNode::AgentTask(entry)) = run.definition.node(&run.definition.entry_node_id)
    else {
        return Vec::new();
    };
    if !entry
        .outputs
        .iter()
        .any(|o| o.kind == WorkflowArtifactKind::Plan)
        || run.nodes.get(&entry.base.id).map(|s| s.outcome) != Some(WorkflowNodeOutcome::Succeeded)
        || existing
            .iter()
            .any(|a| a.node_id() == Some(entry.base.id.as_str()))
    {
        return Vec::new();
    }
    vec![WorkflowNextAction::ReworkStage {
        node_id: entry.base.id.clone(),
        label: format!("Start a new revision from {}", entry.base.name),
    }]
}

fn merge_conflict_actions(run: &WorkflowRun) -> Vec<WorkflowNextAction> {
    run.definition
        .nodes
        .iter()
        .filter_map(|node| {
            merge_conflict_of(run, node.id()).map(|files| WorkflowNextAction::ResolveMergeWithAi {
                node_id: node.id().to_string(),
                label: "Let AI resolve the conflicts".to_string(),
                files,
            })
        })
        .collect()
}

fn status_name(status: WorkflowRunStatus) -> &'static str {
    match status {
        WorkflowRunStatus::Running => "running",
        WorkflowRunStatus::AwaitingApproval => "awaiting-approval",
        WorkflowRunStatus::Succeeded => "succeeded",
        WorkflowRunStatus::Failed => "failed",
        WorkflowRunStatus::Cancelled => "cancelled",
    }
}

/// What a person can actually do with this run right now. Every non-terminal state
/// resolves to at least one concrete action.
#[must_use]
pub fn next_actions(run: &WorkflowRun, now: Option<DateTime<Utc>>) -> Vec<WorkflowNextAction> {
    if is_run_settled(run) {
        let mut actions = vec![WorkflowNextAction::None {
            label: format!(
                "Run {}{}",
                status_name(run.status),
                run.ended_reason
                    .as_deref()
                    .filter(|r| !r.is_empty())
                    .map_or_else(|| ".".to_string(), |r| format!(": {r}"))
            ),
        }];
        if run.status == WorkflowRunStatus::Failed {
            let mut recover = merge_conflict_actions(run);
            recover.extend(retry_actions(run));
            recover.extend(rework_actions(run, now));
            let replan = replan_actions(run, &recover);
            actions.extend(recover);
            actions.extend(replan);
        }
        return actions;
    }

    let schedule = schedule_workflow_run(run);
    let mut actions = Vec::new();
    for node_id in &schedule.awaiting_approval {
        actions.push(WorkflowNextAction::Approve {
            node_id: node_id.clone(),
            label: format!("Approve at {}", label(run, node_id)),
        });
        if matches!(run.definition.node(node_id), Some(WorkflowNode::Approval(a)) if a.optional == Some(true))
        {
            actions.push(WorkflowNextAction::SkipApproval {
                node_id: node_id.clone(),
                label: format!("Skip {}", label(run, node_id)),
            });
        }
    }
    for node_id in &schedule.ready {
        actions.push(WorkflowNextAction::StartStage {
            node_id: node_id.clone(),
            label: format!("Start {}", label(run, node_id)),
        });
    }
    actions.extend(merge_conflict_actions(run));
    actions.extend(retry_actions(run));
    actions.extend(rework_actions(run, now));

    if !schedule.running.is_empty() || !actions.is_empty() {
        actions.push(WorkflowNextAction::CancelRun {
            label: "Cancel run".to_string(),
        });
        return actions;
    }
    vec![
        WorkflowNextAction::None {
            label: schedule.blocked.unwrap_or_else(|| "Waiting.".to_string()),
        },
        WorkflowNextAction::CancelRun {
            label: "Cancel run".to_string(),
        },
    ]
}

/// Stages left unfinished, for a monitor summary line.
#[must_use]
pub fn outstanding_nodes(run: &WorkflowRun) -> Vec<String> {
    let mut ids: Vec<String> = run
        .nodes
        .values()
        .filter(|s| !s.outcome.is_terminal())
        .map(|s| s.node_id.clone())
        .collect();
    ids.sort();
    ids
}
