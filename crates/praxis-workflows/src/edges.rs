//! Edges as the engine reads them (`workflowEdges.ts` port, FX-BE-162).
//!
//! DAG edges (everything without `loop`) drive readiness, snapshots, ancestry and
//! "what is downstream"; loop edges are back-edges with a budget, read only by the loop
//! logic. The findings arithmetic shared by gate thresholds and findings edges lives
//! here too, so "two high findings" means the same thing to both.

use std::collections::{BTreeMap, HashSet};

use crate::run::{WorkflowNodeState, WorkflowRun, WorkflowRunStatus};
use crate::types::{
    CheckFinding, CheckFindingSeverity, CheckFindings, FindingVerdict, FindingsMetricClause,
    MetricOperator, ParameterValue, WORKFLOW_MAX_LOOP_ITERATIONS, WorkflowDefinition, WorkflowEdge,
    WorkflowEdgeOutcome, WorkflowFindingsPredicate, WorkflowNode, WorkflowNodeOutcome,
};
use crate::waivers::{FindingWaiver, filter_unwaived_findings};

/// Run parameter values by id.
pub type RunParameters = BTreeMap<String, ParameterValue>;

/// Numeric rank of a severity (`info` 0 … `critical` 4).
#[must_use]
pub const fn severity_rank(severity: CheckFindingSeverity) -> u8 {
    match severity {
        CheckFindingSeverity::Info => 0,
        CheckFindingSeverity::Low => 1,
        CheckFindingSeverity::Medium => 2,
        CheckFindingSeverity::High => 3,
        CheckFindingSeverity::Critical => 4,
    }
}

/// Whether an edge is a budgeted back-edge.
#[must_use]
pub const fn is_loop_edge(edge: &WorkflowEdge) -> bool {
    edge.loop_budget.is_some()
}

/// The run's DAG: every edge that is not a loop edge.
pub fn dag_edges(definition: &WorkflowDefinition) -> impl Iterator<Item = &WorkflowEdge> {
    definition.edges.iter().filter(|edge| !is_loop_edge(edge))
}

/// Every loop edge, in definition order.
pub fn loop_edges(definition: &WorkflowDefinition) -> impl Iterator<Item = &WorkflowEdge> {
    definition.edges.iter().filter(|edge| is_loop_edge(edge))
}

/// Findings that still count: a skeptic's `refuted` verdict takes a finding out of play.
#[must_use]
pub fn countable_findings(findings: &[CheckFinding]) -> Vec<CheckFinding> {
    findings
        .iter()
        .filter(|finding| finding.verdict != Some(FindingVerdict::Refuted))
        .cloned()
        .collect()
}

/// How many findings sit at or above `level`.
#[must_use]
pub fn count_at_or_above(findings: &[CheckFinding], level: CheckFindingSeverity) -> usize {
    let rank = severity_rank(level);
    findings
        .iter()
        .filter(|finding| severity_rank(finding.severity) >= rank)
        .count()
}

/// Whether `actual <operator> value`. A missing or non-finite reading never holds.
#[must_use]
#[allow(clippy::float_cmp)]
pub fn compare_metric(actual: Option<f64>, operator: MetricOperator, value: f64) -> bool {
    let Some(actual) = actual.filter(|a| a.is_finite()) else {
        return false;
    };
    match operator {
        MetricOperator::Gte => actual >= value,
        MetricOperator::Lte => actual <= value,
        MetricOperator::Gt => actual > value,
        MetricOperator::Lt => actual < value,
        MetricOperator::Eq => actual == value,
    }
}

/// The value a metric clause compares against: a run parameter's, when it names one that
/// was given as a finite number.
#[must_use]
pub fn predicate_metric_value(
    metric: &FindingsMetricClause,
    parameters: Option<&RunParameters>,
) -> f64 {
    metric
        .value_from_parameter
        .as_ref()
        .and_then(|id| parameters?.get(id))
        .and_then(|value| match value {
            ParameterValue::Number(n) if n.is_finite() => Some(*n),
            _ => None,
        })
        .unwrap_or(metric.value)
}

fn has_severity_clause(when: &WorkflowFindingsPredicate) -> bool {
    when.severity.is_some()
        || when.min_count.is_some()
        || when.categories.as_ref().is_some_and(|c| !c.is_empty())
}

fn min_count_of(when: &WorkflowFindingsPredicate) -> f64 {
    when.min_count.unwrap_or(1.0).max(1.0)
}

/// Whether any clause of a findings predicate holds for these findings.
#[must_use]
pub fn findings_predicate_holds(
    predicate: Option<&WorkflowFindingsPredicate>,
    findings: Option<&CheckFindings>,
    parameters: Option<&RunParameters>,
) -> bool {
    let Some(findings) = findings else {
        return false;
    };
    let default = WorkflowFindingsPredicate::default();
    let when = predicate.unwrap_or(&default);

    if has_severity_clause(when) || when.metric.is_none() {
        let categories: Option<HashSet<String>> = when
            .categories
            .as_ref()
            .filter(|c| !c.is_empty())
            .map(|c| c.iter().map(|category| category.to_lowercase()).collect());
        let pool: Vec<CheckFinding> = countable_findings(&findings.findings)
            .into_iter()
            .filter(|finding| {
                categories
                    .as_ref()
                    .is_none_or(|set| set.contains(&finding.category.to_lowercase()))
            })
            .collect();
        let count = count_at_or_above(&pool, when.severity.unwrap_or(CheckFindingSeverity::High));
        #[allow(clippy::cast_precision_loss)]
        if count as f64 >= min_count_of(when) {
            return true;
        }
    }
    when.metric.as_ref().is_some_and(|metric| {
        compare_metric(
            findings.metrics.get(&metric.metric).copied(),
            metric.operator,
            predicate_metric_value(metric, parameters),
        )
    })
}

fn severity_name(severity: CheckFindingSeverity) -> &'static str {
    match severity {
        CheckFindingSeverity::Info => "info",
        CheckFindingSeverity::Low => "low",
        CheckFindingSeverity::Medium => "medium",
        CheckFindingSeverity::High => "high",
        CheckFindingSeverity::Critical => "critical",
    }
}

/// A short, human reading of a predicate: "2+ findings at high or above, or score < 90".
#[must_use]
pub fn describe_findings_predicate(
    predicate: Option<&WorkflowFindingsPredicate>,
    parameters: Option<&RunParameters>,
) -> String {
    let default = WorkflowFindingsPredicate::default();
    let when = predicate.unwrap_or(&default);
    let mut parts: Vec<String> = Vec::new();
    if has_severity_clause(when) || when.metric.is_none() {
        let count = min_count_of(when);
        #[allow(clippy::float_cmp)]
        let subject = if count == 1.0 {
            "any finding".to_string()
        } else {
            format!("{count}+ findings")
        };
        let categories = when
            .categories
            .as_ref()
            .filter(|c| !c.is_empty())
            .map(|c| format!(" in {}", c.join("/")))
            .unwrap_or_default();
        parts.push(format!(
            "{subject} at {} or above{categories}",
            severity_name(when.severity.unwrap_or(CheckFindingSeverity::High))
        ));
    }
    if let Some(metric) = &when.metric {
        parts.push(format!(
            "{} {} {}",
            metric.metric,
            metric.operator.as_str(),
            predicate_metric_value(metric, parameters)
        ));
    }
    parts.join(", or ")
}

/// Whether a skeptic of `node_id` (`refutes`) has yet to deliver its verdicts.
#[must_use]
pub fn awaiting_skeptic(run: &WorkflowRun, node_id: &str) -> bool {
    run.definition.nodes.iter().any(|node| {
        let WorkflowNode::AgentTask(task) = node else {
            return false;
        };
        if task.refutes.as_deref() != Some(node_id) || !node.is_enabled() {
            return false;
        }
        run.nodes.get(node.id()).is_some_and(|state| {
            matches!(
                state.outcome,
                WorkflowNodeOutcome::Pending
                    | WorkflowNodeOutcome::Ready
                    | WorkflowNodeOutcome::Running
            )
        })
    })
}

/// How an inbound edge stands given its source node's recorded outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeState {
    Satisfied,
    Dead,
    Waiting,
}

/// Whether `edge` is taken given its source's state. Shared by the scheduler (DAG edges)
/// and the loop logic, so a loop edge fires on exactly the outcome a forward edge would.
#[must_use]
pub fn edge_state_for(
    edge: &WorkflowEdge,
    source: Option<&WorkflowNodeState>,
    recovery_exhausted: Option<bool>,
    parameters: Option<&RunParameters>,
) -> EdgeState {
    let Some(source) = source else {
        return EdgeState::Dead;
    };
    let on_findings = || {
        if findings_predicate_holds(edge.when.as_ref(), source.findings.as_ref(), parameters) {
            EdgeState::Satisfied
        } else {
            EdgeState::Dead
        }
    };
    match source.outcome {
        WorkflowNodeOutcome::Succeeded => match edge.on {
            WorkflowEdgeOutcome::Findings => on_findings(),
            WorkflowEdgeOutcome::Success | WorkflowEdgeOutcome::Always => EdgeState::Satisfied,
            WorkflowEdgeOutcome::Failure => EdgeState::Dead,
        },
        WorkflowNodeOutcome::Failed => {
            // Paused: the stage has no verdict yet, so no edge is taken.
            if source
                .attempts
                .last()
                .is_some_and(|attempt| attempt.pause.is_some())
            {
                return EdgeState::Waiting;
            }
            match edge.on {
                WorkflowEdgeOutcome::Findings => on_findings(),
                WorkflowEdgeOutcome::Success => EdgeState::Dead,
                WorkflowEdgeOutcome::Failure | WorkflowEdgeOutcome::Always => {
                    if recovery_exhausted == Some(true) {
                        EdgeState::Dead
                    } else {
                        EdgeState::Satisfied
                    }
                }
            }
        }
        // The source never ran, so nothing downstream of it can be reached.
        WorkflowNodeOutcome::Skipped | WorkflowNodeOutcome::Cancelled => EdgeState::Dead,
        WorkflowNodeOutcome::Pending
        | WorkflowNodeOutcome::Ready
        | WorkflowNodeOutcome::Running => EdgeState::Waiting,
    }
}

// ── Loops ────────────────────────────────────────────────────────────────

/// Where one loop edge stands in a run.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopStatus {
    pub edge: WorkflowEdge,
    /// Times the loop has been taken in this run's current revision.
    pub iterations_taken: u32,
    /// Times it may be taken, after parameter overrides and grants, capped.
    pub budget: u32,
    /// The source's latest result satisfies the edge and no one has accepted it.
    pub fires: bool,
    /// Fires with nothing left in the budget: a person must decide.
    pub exhausted: bool,
    /// A keep-best loop that stopped after `patience` passes without beating the best.
    pub out_of_patience: bool,
}

/// Passes in a row, ending with `current_score`, that did not beat the best before them.
#[must_use]
pub fn passes_without_improvement(
    history: &[(String, Option<f64>)],
    edge_id: &str,
    current_score: Option<f64>,
    higher_is_better: bool,
) -> u32 {
    let mut best: Option<f64> = None;
    let mut streak = 0;
    let scores = history
        .iter()
        .filter(|(id, _)| id == edge_id)
        .map(|(_, score)| *score)
        .chain(std::iter::once(current_score));
    for score in scores.flatten() {
        let better = best.is_none_or(|b| {
            if higher_is_better {
                score > b
            } else {
                score < b
            }
        });
        if better {
            best = Some(score);
            streak = 0;
        } else {
            streak += 1;
        }
    }
    streak
}

/// Waivers declared on the workflow's approval stages.
#[must_use]
pub fn definition_waivers(definition: &WorkflowDefinition) -> Vec<FindingWaiver> {
    definition
        .nodes
        .iter()
        .filter_map(|node| match node {
            WorkflowNode::Approval(approval) => approval.waivers.clone(),
            _ => None,
        })
        .flatten()
        .collect()
}

/// When a person last started a new revision of this run, if they have.
#[must_use]
pub fn current_revision_start(run: &WorkflowRun) -> Option<&str> {
    run.events
        .iter()
        .rev()
        .find(|event| event.kind == crate::run::WorkflowRunEventKind::RevisionStarted)
        .map(|event| event.at.as_str())
}

/// Times a loop edge has been taken in this run's current revision.
#[must_use]
pub fn loop_iterations_taken(run: &WorkflowRun, edge_id: &str) -> u32 {
    let since = current_revision_start(run);
    let count = run
        .loop_history
        .iter()
        .flatten()
        .filter(|entry| entry.edge_id == edge_id && since.is_none_or(|s| entry.at.as_str() > s))
        .count();
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// A loop's budget for this run: `maxIterations`, replaced by an integer run parameter
/// bound to the edge, plus every grant in this revision — never more than the cap.
#[must_use]
pub fn loop_budget(run: &WorkflowRun, edge: &WorkflowEdge) -> u32 {
    let since = current_revision_start(run);
    let bound = run
        .definition
        .parameters
        .iter()
        .flatten()
        .find(|parameter| parameter.binds_loop_edge.as_deref() == Some(edge.id.as_str()));
    let from_parameter = bound
        .and_then(|parameter| run.parameters.as_ref()?.get(&parameter.id))
        .and_then(|value| match value {
            ParameterValue::Number(n) if n.fract() == 0.0 && *n >= 1.0 && n.is_finite() =>
            {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                Some(n.min(f64::from(u32::MAX)) as u32)
            }
            _ => None,
        });
    let base = from_parameter
        .or_else(|| {
            edge.loop_budget
                .as_ref()
                .map(|budget| budget.max_iterations)
        })
        .unwrap_or(0);
    let granted: u32 = run
        .loop_decisions
        .iter()
        .flatten()
        .filter(|decision| {
            decision.edge_id == edge.id
                && decision.decision == crate::run::LoopDecisionKind::Grant
                && since.is_none_or(|s| decision.at.as_str() > s)
        })
        .map(|decision| decision.extra_iterations.unwrap_or(0))
        .sum();
    WORKFLOW_MAX_LOOP_ITERATIONS.min(base.saturating_add(granted))
}

/// Every loop edge's status, in definition order.
#[must_use]
pub fn loop_statuses(run: &WorkflowRun) -> Vec<LoopStatus> {
    let waivers = definition_waivers(&run.definition);
    let history: Vec<(String, Option<f64>)> = run
        .loop_history
        .iter()
        .flatten()
        .map(|entry| (entry.edge_id.clone(), entry.score))
        .collect();
    loop_edges(&run.definition)
        .map(|edge| {
            let recorded = run.nodes.get(&edge.from);
            // A finding someone waived is a decision already made: it must not send the loop round.
            let waived;
            let source = match recorded {
                Some(state) if state.findings.is_some() && !waivers.is_empty() => {
                    let mut copy = state.clone();
                    if let Some(findings) = copy.findings.as_mut() {
                        findings.findings =
                            filter_unwaived_findings(&findings.findings, &waivers, None, None).0;
                    }
                    waived = copy;
                    Some(&waived)
                }
                other => other,
            };
            let iterations_taken = loop_iterations_taken(run, &edge.id);
            let budget = loop_budget(run, edge);
            let satisfied = edge_state_for(edge, source, None, run.parameters.as_ref())
                == EdgeState::Satisfied
                && !(edge.on == WorkflowEdgeOutcome::Findings && awaiting_skeptic(run, &edge.from));
            let keep_best = edge.loop_budget.as_ref().and_then(|l| l.keep_best.as_ref());
            let out_of_patience = satisfied
                && keep_best.is_some_and(|keep| {
                    keep.patience.is_some_and(|patience| {
                        patience > 0
                            && passes_without_improvement(
                                &history,
                                &edge.id,
                                source
                                    .and_then(|s| s.findings.as_ref())
                                    .and_then(|f| f.metrics.get(&keep.metric).copied()),
                                keep.higher_is_better,
                            ) >= patience
                    })
                });
            let accepted = source.is_some_and(|state| {
                run.loop_decisions.iter().flatten().any(|decision| {
                    decision.edge_id == edge.id
                        && decision.decision == crate::run::LoopDecisionKind::Accept
                        && decision.source_attempt == state.attempts.len()
                })
            });
            let fires = satisfied && !accepted && !out_of_patience;
            LoopStatus {
                edge: edge.clone(),
                iterations_taken,
                budget,
                fires,
                exhausted: fires && iterations_taken >= budget,
                out_of_patience,
            }
        })
        .collect()
}

/// What the run must do about a firing loop edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingLoopKind {
    /// Take it once nothing is running.
    Take,
    /// Its budget is spent; a person must decide.
    Decide,
}

/// The loop the run must act on next: the first firing loop edge in definition order.
#[must_use]
pub fn pending_loop(run: &WorkflowRun) -> Option<(PendingLoopKind, LoopStatus)> {
    if matches!(
        run.status,
        WorkflowRunStatus::Succeeded | WorkflowRunStatus::Failed | WorkflowRunStatus::Cancelled
    ) {
        return None;
    }
    let status = loop_statuses(run).into_iter().find(|status| status.fires)?;
    let kind = if status.exhausted {
        PendingLoopKind::Decide
    } else {
        PendingLoopKind::Take
    };
    Some((kind, status))
}
