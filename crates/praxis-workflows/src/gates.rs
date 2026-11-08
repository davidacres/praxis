//! Gate evaluation, approval, and audited bypass (`workflowGates.ts` port, FX-BE-020).
//!
//! A gate is satisfied by a **node outcome**, never by a claim: the node that declares
//! `satisfiesGate` owns it, and its outcome is decided by the engine. Policy passed in must
//! be the composed (strictest-wins) profile for the project.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::edges::{compare_metric, count_at_or_above, countable_findings};
use crate::run::{
    RevisionFindingItem, WorkflowPauseReason, WorkflowRun, WorkflowRunCommand, apply_command,
    pause_reason_of,
};
use crate::scheduler::schedule_workflow_run;
use crate::stage_session::find_snapshot;
use crate::types::{
    CheckFinding, CheckFindingSeverity, CheckFindings, GateThresholdCondition, ObserveProvider,
    WorkflowApprovalNode, WorkflowGateDecision, WorkflowGateKind, WorkflowNode,
    WorkflowNodeOutcome, WorkflowPolicyProfile,
};
use crate::waivers::{FindingWaiver, filter_unwaived_findings};

/// Where a gate stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GateState {
    Passed,
    Failed,
    Pending,
    Stale,
    Missing,
    Bypassed,
}

impl GateState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Pending => "pending",
            Self::Stale => "stale",
            Self::Missing => "missing",
            Self::Bypassed => "bypassed",
        }
    }
}

/// One gate's evaluation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateStatus {
    pub gate: WorkflowGateKind,
    /// The node that owns this gate, when exactly one does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub state: GateState,
    /// Whether the gate rests on a deterministic check rather than an agent.
    pub deterministic: bool,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bypassable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bypass_blocked_by_policy: Option<bool>,
}

/// CI evidence imported for an observing check (TASK-252).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiImportedEvidenceRecord {
    pub provider: ObserveProvider,
    pub run_id: String,
    pub sha: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub findings: Option<CheckFindings>,
}

/// CI evidence keyed by owner node id or gate name.
pub type CiImportedEvidenceState = BTreeMap<String, CiImportedEvidenceRecord>;

/// Whether approval may be offered, and what stands in the way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalReadiness {
    pub can_approve: bool,
    pub blocking: Vec<GateStatus>,
    pub bypassable: Vec<GateStatus>,
    pub gates: Vec<GateStatus>,
}

const fn severity_name(severity: CheckFindingSeverity) -> &'static str {
    match severity {
        CheckFindingSeverity::Info => "info",
        CheckFindingSeverity::Low => "low",
        CheckFindingSeverity::Medium => "medium",
        CheckFindingSeverity::High => "high",
        CheckFindingSeverity::Critical => "critical",
    }
}

const fn provider_name(provider: ObserveProvider) -> &'static str {
    match provider {
        ObserveProvider::GithubActions => "github-actions",
        ObserveProvider::GitlabCi => "gitlab-ci",
    }
}

fn is_deterministic(node: &WorkflowNode) -> bool {
    matches!(node, WorkflowNode::Check(_) | WorkflowNode::Deployment(_))
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn approval_of<'a>(run: &'a WorkflowRun, node_id: &str) -> Option<&'a WorkflowApprovalNode> {
    match run.definition.node(node_id) {
        Some(WorkflowNode::Approval(approval)) => Some(approval),
        _ => None,
    }
}

fn status(
    gate: WorkflowGateKind,
    node_id: Option<&str>,
    state: GateState,
    deterministic: bool,
    detail: String,
) -> GateStatus {
    GateStatus {
        gate,
        node_id: node_id.map(str::to_string),
        state,
        deterministic,
        detail,
        bypassable: None,
        approval_node_id: None,
        bypass_blocked_by_policy: None,
    }
}

fn conditions_for(
    policy: Option<&WorkflowPolicyProfile>,
    approval: &WorkflowApprovalNode,
    gate: WorkflowGateKind,
) -> Vec<GateThresholdCondition> {
    let from = |thresholds: Option<&BTreeMap<WorkflowGateKind, Vec<GateThresholdCondition>>>| {
        thresholds
            .and_then(|t| t.get(&gate))
            .cloned()
            .unwrap_or_default()
    };
    let mut conditions = from(policy.and_then(|p| p.gate_thresholds.as_ref()));
    conditions.extend(from(approval.gate_thresholds.as_ref()));
    conditions
}

/// The first threshold a stage's findings break, as a gate-failure detail.
fn threshold_failure(
    conditions: &[GateThresholdCondition],
    findings: Option<&CheckFindings>,
    active: &[CheckFinding],
    severity_suffix: &str,
    metrics: Option<&BTreeMap<String, f64>>,
) -> Option<String> {
    for condition in conditions {
        match condition {
            GateThresholdCondition::Metric {
                metric,
                operator,
                value,
            } => {
                let actual = metrics
                    .or(findings.map(|f| &f.metrics))
                    .and_then(|m| m.get(metric).copied());
                if !compare_metric(actual, *operator, *value) {
                    return Some(format!(
                        "Metric \"{metric}\" was {}, required {} {value}.",
                        actual.map_or_else(|| "missing".to_string(), |a| a.to_string()),
                        operator.as_str()
                    ));
                }
            }
            GateThresholdCondition::Severity {
                severity_level,
                max_count,
            } => {
                let level = severity_level.unwrap_or(CheckFindingSeverity::High);
                let count = count_at_or_above(active, level);
                #[allow(clippy::cast_precision_loss)]
                if count as f64 > *max_count {
                    return Some(format!(
                        "Found {count} finding(s) with severity >= {}{severity_suffix} (max allowed: {max_count}).",
                        severity_name(level)
                    ));
                }
            }
        }
    }
    None
}

/// Evaluates every gate an approval node requires, widened by policy. `now` decides which
/// waivers are still active (defaults to the current time).
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn evaluate_gates(
    run: &WorkflowRun,
    approval_node_id: &str,
    policy: Option<&WorkflowPolicyProfile>,
    ci_evidence: Option<&CiImportedEvidenceState>,
    now: Option<DateTime<Utc>>,
) -> Vec<GateStatus> {
    let Some(approval) = approval_of(run, approval_node_id) else {
        return Vec::new();
    };
    let now = Some(now.unwrap_or_else(Utc::now));
    let mut required: Vec<WorkflowGateKind> = approval.required_gates.clone();
    required.extend(policy.map(|p| p.required_gates.clone()).unwrap_or_default());
    required.sort_by_key(|gate| gate.as_str());
    required.dedup();

    let waivers: Vec<FindingWaiver> = policy
        .and_then(|p| p.waivers.clone())
        .unwrap_or_default()
        .into_iter()
        .chain(approval.waivers.clone().unwrap_or_default())
        .collect();
    let current_snapshot_ref = run
        .nodes
        .values()
        .find_map(|n| n.snapshot_ref.clone().filter(|r| !r.is_empty()));
    let current_ref = current_snapshot_ref.as_deref();

    required
        .into_iter()
        .map(|gate| {
            let owners: Vec<&WorkflowNode> = run
                .definition
                .nodes
                .iter()
                .filter(|n| n.gate() == Some(gate))
                .collect();
            let decision = run.gate_decisions.iter().find(|d| d.gate == gate);
            let current_snapshot = if owners.len() == 1 {
                find_snapshot(run, owners[0].id()).map(|s| s.reference)
            } else {
                None
            };
            let sole_owner = (owners.len() == 1).then(|| owners[0].id());

            if let Some(decision) = decision.filter(|d| d.bypassed)
                && current_snapshot.as_ref().is_none_or(|snapshot| {
                    decision.assessed_snapshot_ref.as_ref() == Some(snapshot)
                })
            {
                return status(
                    gate,
                    sole_owner,
                    GateState::Bypassed,
                    !owners.is_empty() && owners.iter().all(|o| is_deterministic(o)),
                    format!(
                        "Bypassed by {}: {}",
                        decision.bypassed_by.as_deref().unwrap_or("unknown"),
                        decision.reason.as_deref().unwrap_or("no reason given")
                    ),
                );
            }

            if owners.is_empty() {
                return status(
                    gate,
                    None,
                    GateState::Missing,
                    false,
                    format!(
                        "No stage in this workflow satisfies the \"{}\" gate.",
                        gate.as_str()
                    ),
                );
            }

            if let [owner] = owners.as_slice() {
                return evaluate_single_owner(
                    run,
                    approval,
                    policy,
                    ci_evidence,
                    gate,
                    owner,
                    current_snapshot.as_deref(),
                    &waivers,
                    now,
                    current_ref,
                );
            }
            evaluate_multi_owner(
                run,
                approval,
                policy,
                gate,
                &owners,
                &waivers,
                now,
                current_ref,
            )
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn evaluate_single_owner(
    run: &WorkflowRun,
    approval: &WorkflowApprovalNode,
    policy: Option<&WorkflowPolicyProfile>,
    ci_evidence: Option<&CiImportedEvidenceState>,
    gate: WorkflowGateKind,
    owner: &WorkflowNode,
    current_snapshot: Option<&str>,
    waivers: &[FindingWaiver],
    now: Option<DateTime<Utc>>,
    current_ref: Option<&str>,
) -> GateStatus {
    let deterministic = is_deterministic(owner);
    let id = Some(owner.id());
    let name = owner.name();

    // Observe mode for CI evidence (TASK-252).
    if let WorkflowNode::Check(check) = owner
        && check.observe.as_ref().is_some_and(|o| o.enabled)
        && let Some(evidence) =
            ci_evidence.and_then(|ci| ci.get(owner.id()).or_else(|| ci.get(gate.as_str())))
        && Some(evidence.sha.as_str()) == current_ref
    {
        if !evidence.available {
            return status(
                gate,
                id,
                GateState::Pending,
                deterministic,
                format!(
                    "{name} is observing CI for {}: report reconciling/not yet available.",
                    short(&evidence.sha)
                ),
            );
        }
        let raw = evidence
            .findings
            .as_ref()
            .map(|f| f.findings.as_slice())
            .unwrap_or_default();
        let (active, waived) =
            filter_unwaived_findings(&countable_findings(raw), waivers, now, current_ref);
        let source = format!(
            "Observed from CI ({} run {}@{})",
            provider_name(evidence.provider),
            evidence.run_id,
            short(&evidence.sha)
        );
        for condition in conditions_for(policy, approval, gate) {
            if let GateThresholdCondition::Severity {
                severity_level,
                max_count,
            } = condition
            {
                let level = severity_level.unwrap_or(CheckFindingSeverity::High);
                let count = count_at_or_above(&active, level);
                #[allow(clippy::cast_precision_loss)]
                if count as f64 > max_count {
                    return status(
                        gate,
                        id,
                        GateState::Failed,
                        deterministic,
                        format!(
                            "{source}: Found {count} finding(s) with severity >= {} (max allowed: {max_count}).",
                            severity_name(level)
                        ),
                    );
                }
            }
        }
        let note = if waived.is_empty() {
            String::new()
        } else {
            format!(" ({} findings waived)", waived.len())
        };
        return status(
            gate,
            id,
            GateState::Passed,
            deterministic,
            format!("{source}{note}."),
        );
    }

    let Some(state) = run.nodes.get(owner.id()) else {
        return status(
            gate,
            id,
            GateState::Pending,
            deterministic,
            format!("{name} has not finished."),
        );
    };
    if matches!(
        state.outcome,
        WorkflowNodeOutcome::Pending | WorkflowNodeOutcome::Ready | WorkflowNodeOutcome::Running
    ) {
        return status(
            gate,
            id,
            GateState::Pending,
            deterministic,
            format!("{name} has not finished."),
        );
    }
    // A paused owner never got to judge the work, so the gate has no verdict yet.
    if let Some(pause) = pause_reason_of(state) {
        let detail = if pause == WorkflowPauseReason::Environment {
            format!("{name} could not run in this environment; it has not checked anything yet.")
        } else {
            format!("{name} is paused on the AI provider's limit; it has not finished.")
        };
        return status(gate, id, GateState::Pending, deterministic, detail);
    }
    match state.outcome {
        WorkflowNodeOutcome::Failed
        | WorkflowNodeOutcome::Cancelled
        | WorkflowNodeOutcome::Skipped => {
            let outcome = match state.outcome {
                WorkflowNodeOutcome::Failed => "failed",
                WorkflowNodeOutcome::Cancelled => "cancelled",
                _ => "skipped",
            };
            status(
                gate,
                id,
                GateState::Failed,
                deterministic,
                format!("{name} {outcome}."),
            )
        }
        WorkflowNodeOutcome::Succeeded => {
            if let Some(snapshot) = current_snapshot
                && state.assessed_snapshot_ref.as_deref() != Some(snapshot)
            {
                return status(
                    gate,
                    id,
                    GateState::Stale,
                    deterministic,
                    format!(
                        "{name} assessed {}, but implementation is now {snapshot}. Re-run this stage.",
                        state
                            .assessed_snapshot_ref
                            .as_deref()
                            .unwrap_or("an unrecorded snapshot")
                    ),
                );
            }
            let raw = state
                .findings
                .as_ref()
                .map(|f| f.findings.as_slice())
                .unwrap_or_default();
            // A finding a skeptic refuted is not a finding the change has.
            let (active, waived) =
                filter_unwaived_findings(&countable_findings(raw), waivers, now, current_ref);
            if let Some(detail) = threshold_failure(
                &conditions_for(policy, approval, gate),
                state.findings.as_ref(),
                &active,
                "",
                None,
            ) {
                return status(gate, id, GateState::Failed, deterministic, detail);
            }
            let note = if waived.is_empty() {
                String::new()
            } else {
                format!(" ({} findings waived)", waived.len())
            };
            status(
                gate,
                id,
                GateState::Passed,
                deterministic,
                format!("{name} succeeded{note}."),
            )
        }
        _ => status(
            gate,
            id,
            GateState::Pending,
            deterministic,
            format!("{name} has not finished."),
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn evaluate_multi_owner(
    run: &WorkflowRun,
    approval: &WorkflowApprovalNode,
    policy: Option<&WorkflowPolicyProfile>,
    gate: WorkflowGateKind,
    owners: &[&WorkflowNode],
    waivers: &[FindingWaiver],
    now: Option<DateTime<Utc>>,
    current_ref: Option<&str>,
) -> GateStatus {
    let skipped = |o: &WorkflowNode| {
        !o.is_enabled()
            || run
                .nodes
                .get(o.id())
                .is_some_and(|s| s.outcome == WorkflowNodeOutcome::Skipped)
    };
    let enabled: Vec<&WorkflowNode> = owners.iter().copied().filter(|o| !skipped(o)).collect();
    let disabled: Vec<&WorkflowNode> = owners.iter().copied().filter(|o| skipped(o)).collect();
    let deterministic = owners.iter().all(|o| is_deterministic(o));

    if enabled.is_empty() {
        return status(
            gate,
            None,
            GateState::Failed,
            deterministic,
            format!("All scanners for gate \"{}\" are disabled.", gate.as_str()),
        );
    }

    let failed: Vec<&WorkflowNode> = enabled
        .iter()
        .copied()
        .filter(|o| {
            run.nodes.get(o.id()).is_some_and(|st| {
                (st.outcome == WorkflowNodeOutcome::Failed && pause_reason_of(st).is_none())
                    || st.outcome == WorkflowNodeOutcome::Cancelled
            })
        })
        .collect();
    if !failed.is_empty() {
        let parts: Vec<String> = failed
            .iter()
            .map(|o| {
                let outcome = run.nodes.get(o.id()).map_or("failed", |s| {
                    if s.outcome == WorkflowNodeOutcome::Cancelled {
                        "cancelled"
                    } else {
                        "failed"
                    }
                });
                format!("{} {outcome}", o.name())
            })
            .collect();
        return status(
            gate,
            None,
            GateState::Failed,
            deterministic,
            format!("{}.", parts.join("; ")),
        );
    }

    let pending: Vec<&str> = enabled
        .iter()
        .filter(|o| {
            run.nodes.get(o.id()).is_none_or(|st| {
                matches!(
                    st.outcome,
                    WorkflowNodeOutcome::Pending
                        | WorkflowNodeOutcome::Ready
                        | WorkflowNodeOutcome::Running
                ) || pause_reason_of(st).is_some()
            })
        })
        .map(|o| o.name())
        .collect();
    if !pending.is_empty() {
        return status(
            gate,
            None,
            GateState::Pending,
            deterministic,
            format!("{} has not finished.", pending.join(", ")),
        );
    }

    let stale: Vec<String> = enabled
        .iter()
        .filter_map(|owner| {
            let snapshot = find_snapshot(run, owner.id())?.reference;
            let assessed = run
                .nodes
                .get(owner.id())
                .and_then(|s| s.assessed_snapshot_ref.clone());
            (assessed.as_deref() != Some(snapshot.as_str())).then(|| {
                format!(
                    "{} assessed {} instead of {snapshot}",
                    owner.name(),
                    assessed.as_deref().unwrap_or("an unrecorded snapshot")
                )
            })
        })
        .collect();
    if !stale.is_empty() {
        return status(
            gate,
            None,
            GateState::Stale,
            deterministic,
            format!(
                "{}. Re-run the stale stage{}.",
                stale.join("; "),
                if stale.len() == 1 { "" } else { "s" }
            ),
        );
    }

    // All enabled owners succeeded: combine findings and metrics (later owners win, like Object.assign).
    let combined: Vec<CheckFinding> = enabled
        .iter()
        .flat_map(|o| {
            run.nodes
                .get(o.id())
                .and_then(|s| s.findings.as_ref())
                .map(|f| f.findings.clone())
                .unwrap_or_default()
        })
        .collect();
    let mut metrics: BTreeMap<String, f64> = BTreeMap::new();
    for owner in &enabled {
        if let Some(findings) = run.nodes.get(owner.id()).and_then(|s| s.findings.as_ref()) {
            metrics.extend(findings.metrics.clone());
        }
    }
    let (active, waived) =
        filter_unwaived_findings(&countable_findings(&combined), waivers, now, current_ref);
    if let Some(detail) = threshold_failure(
        &conditions_for(policy, approval, gate),
        None,
        &active,
        " across scanners",
        Some(&metrics),
    ) {
        return status(gate, None, GateState::Failed, deterministic, detail);
    }
    let disabled_text = if disabled.is_empty() {
        String::new()
    } else {
        format!(
            " ({})",
            disabled
                .iter()
                .map(|o| format!("{} disabled", o.name()))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let waived_text = if waived.is_empty() {
        String::new()
    } else {
        format!(", {} waived", waived.len())
    };
    status(
        gate,
        None,
        GateState::Passed,
        deterministic,
        format!(
            "Scanners passed: {}{disabled_text} ({} findings{waived_text}).",
            enabled
                .iter()
                .map(|o| o.name())
                .collect::<Vec<_>>()
                .join(", "),
            active.len()
        ),
    )
}

/// The findings currently failing a gate, by the stage that reported them. Waived,
/// refuted and info findings are left out.
#[must_use]
pub fn failing_gate_findings(
    run: &WorkflowRun,
    policy: Option<&WorkflowPolicyProfile>,
    now: Option<DateTime<Utc>>,
) -> Vec<RevisionFindingItem> {
    let now = Some(now.unwrap_or_else(Utc::now));
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for node in &run.definition.nodes {
        let WorkflowNode::Approval(approval) = node else {
            continue;
        };
        let waivers: Vec<FindingWaiver> = policy
            .and_then(|p| p.waivers.clone())
            .unwrap_or_default()
            .into_iter()
            .chain(approval.waivers.clone().unwrap_or_default())
            .collect();
        for gate in evaluate_gates(run, &approval.base.id, policy, None, now) {
            if gate.state != GateState::Failed {
                continue;
            }
            for owner in run
                .definition
                .nodes
                .iter()
                .filter(|n| n.gate() == Some(gate.gate))
            {
                let findings = run
                    .nodes
                    .get(owner.id())
                    .and_then(|s| s.findings.as_ref())
                    .map(|f| f.findings.as_slice())
                    .unwrap_or_default();
                let (active, _) =
                    filter_unwaived_findings(&countable_findings(findings), &waivers, now, None);
                for finding in active {
                    if finding.severity == CheckFindingSeverity::Info {
                        continue;
                    }
                    if seen.insert(format!("{}:{}", owner.id(), finding.fingerprint)) {
                        out.push(RevisionFindingItem {
                            stage: owner.name().to_string(),
                            finding,
                        });
                    }
                }
            }
        }
    }
    out
}

/// The closest mutating agent stage upstream of every blocking finding's owner.
#[must_use]
pub fn repair_stage_for_findings(
    run: &WorkflowRun,
    findings: &[RevisionFindingItem],
) -> Option<String> {
    if findings.is_empty() {
        return None;
    }
    let nodes = &run.definition.nodes;
    let is_writer = |id: &str| matches!(run.definition.node(id), Some(WorkflowNode::AgentTask(task)) if task.mutates_worktree);
    let mut parents: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in run
        .definition
        .edges
        .iter()
        .filter(|e| e.loop_budget.is_none())
    {
        parents
            .entry(edge.to.as_str())
            .or_default()
            .push(edge.from.as_str());
    }
    let candidates: Vec<indexmap::IndexMap<String, usize>> = findings
        .iter()
        .map(|item| {
            // Like a JS Map built from entries, the last node with a name wins.
            let Some(owner) = nodes.iter().rev().find(|n| n.name() == item.stage) else {
                return indexmap::IndexMap::new();
            };
            let mut distances: indexmap::IndexMap<String, usize> = indexmap::IndexMap::new();
            let mut queue: VecDeque<(&str, usize)> = VecDeque::from([(owner.id(), 0)]);
            while let Some((id, distance)) = queue.pop_front() {
                if distances.contains_key(id) {
                    continue;
                }
                distances.insert(id.to_string(), distance);
                if is_writer(id) {
                    continue;
                }
                for parent in parents.get(id).into_iter().flatten() {
                    queue.push_back((parent, distance + 1));
                }
            }
            distances.retain(|id, _| is_writer(id));
            distances
        })
        .collect();
    if candidates.iter().any(indexmap::IndexMap::is_empty) {
        return None;
    }
    // Ties keep the first finding's BFS discovery order, as the stable TS sort does.
    let shared: Vec<&String> = candidates[0]
        .keys()
        .filter(|id| candidates.iter().all(|c| c.contains_key(*id)))
        .collect();
    let score = |id: &String| {
        let distances: Vec<usize> = candidates.iter().map(|c| c[id]).collect();
        (
            distances.iter().copied().max().unwrap_or(0),
            distances.iter().sum::<usize>(),
        )
    };
    shared.into_iter().min_by_key(|id| score(id)).cloned()
}

/// Resolves which approval node an approve/bypass action targets; refuses to guess.
pub fn resolve_approval_target<'a>(
    run: &'a WorkflowRun,
    node_id: Option<&str>,
) -> Result<&'a WorkflowApprovalNode, String> {
    let approvals: Vec<&WorkflowApprovalNode> = run
        .definition
        .nodes
        .iter()
        .filter_map(|n| match n {
            WorkflowNode::Approval(a) => Some(a),
            _ => None,
        })
        .collect();
    if let Some(node_id) = node_id.filter(|id| !id.is_empty()) {
        return approvals
            .into_iter()
            .find(|a| a.base.id == node_id)
            .ok_or_else(|| format!("\"{node_id}\" is not an approval stage in this workflow."));
    }
    match approvals.as_slice() {
        [] => Err("This workflow has no approval stage.".to_string()),
        [only] => Ok(only),
        _ => {
            let awaiting: HashSet<String> = schedule_workflow_run(run)
                .awaiting_approval
                .into_iter()
                .collect();
            let ready: Vec<&WorkflowApprovalNode> = approvals
                .into_iter()
                .filter(|a| awaiting.contains(&a.base.id))
                .collect();
            match ready.as_slice() {
                [only] => Ok(only),
                _ => Err(
                    "This workflow has multiple approval stages; specify which one to approve."
                        .to_string(),
                ),
            }
        }
    }
}

/// Whether approval may be offered. A gate is bypassable only when both policy and the
/// approval node allow it, and never while it is still pending.
#[must_use]
pub fn approval_readiness(
    run: &WorkflowRun,
    approval_node_id: &str,
    policy: Option<&WorkflowPolicyProfile>,
    now: Option<DateTime<Utc>>,
) -> ApprovalReadiness {
    let gates = evaluate_gates(run, approval_node_id, policy, None, now);
    let blocking: Vec<GateStatus> = gates
        .iter()
        .filter(|g| g.state != GateState::Passed && g.state != GateState::Bypassed)
        .cloned()
        .collect();
    let bypass_allowed = approval_of(run, approval_node_id).is_some_and(|a| a.allow_bypass)
        && policy.is_some_and(|p| p.allow_gate_bypass);
    ApprovalReadiness {
        can_approve: blocking.is_empty(),
        bypassable: if bypass_allowed {
            blocking
                .iter()
                .filter(|g| g.state != GateState::Pending)
                .cloned()
                .collect()
        } else {
            Vec::new()
        },
        blocking,
        gates,
    }
}

/// The result of a gate action that may be refused.
#[derive(Debug, Clone, PartialEq)]
pub struct GateActionResult {
    pub run: WorkflowRun,
    pub ok: bool,
    pub reason: Option<String>,
}

fn refused(run: &WorkflowRun, reason: String) -> GateActionResult {
    GateActionResult {
        run: run.clone(),
        ok: false,
        reason: Some(reason),
    }
}

/// Who is overriding which gate, why, and when.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateBypassInput {
    pub gate: WorkflowGateKind,
    /// Required — an anonymous bypass is not auditable.
    pub actor: String,
    /// Required, and refused if blank.
    pub reason: String,
    pub at: String,
}

/// Records an attributed bypass. Refuses (with a reason) for policy or state violations;
/// errors for a blank actor or reason.
pub fn bypass_gate(
    run: &WorkflowRun,
    approval_node_id: &str,
    input: &GateBypassInput,
    policy: Option<&WorkflowPolicyProfile>,
    now: Option<DateTime<Utc>>,
) -> Result<GateActionResult, String> {
    let GateBypassInput {
        gate,
        actor,
        reason,
        at,
    } = input;
    let (gate, actor, reason, at) = (*gate, actor.as_str(), reason.as_str(), at.as_str());
    if actor.trim().is_empty() {
        return Err("A gate bypass must record who performed it.".to_string());
    }
    if reason.trim().is_empty() {
        return Err("A gate bypass must record why.".to_string());
    }
    let readiness = approval_readiness(run, approval_node_id, policy, now);
    let Some(target) = readiness.bypassable.iter().find(|g| g.gate == gate) else {
        let name = gate.as_str();
        let message = match readiness.gates.iter().find(|g| g.gate == gate) {
            None => format!("Gate \"{name}\" is not required here."),
            Some(known) if known.state == GateState::Pending => {
                format!("Gate \"{name}\" has not finished; wait for it rather than bypassing it.")
            }
            Some(_) => format!("Gate \"{name}\" cannot be bypassed under the active policy."),
        };
        return Ok(refused(run, message));
    };
    let decision = WorkflowGateDecision {
        gate,
        node_id: target
            .node_id
            .clone()
            .unwrap_or_else(|| approval_node_id.to_string()),
        passed: false,
        bypassed: true,
        bypassed_by: Some(actor.to_string()),
        reason: Some(reason.to_string()),
        assessed_snapshot_ref: target
            .node_id
            .as_deref()
            .and_then(|id| find_snapshot(run, id))
            .map(|s| s.reference),
        decided_at: at.to_string(),
    };
    Ok(GateActionResult {
        run: apply_command(
            run.clone(),
            &WorkflowRunCommand::GateDecided {
                at: at.to_string(),
                decision,
            },
        ),
        ok: true,
        reason: None,
    })
}

/// Grants approval, settling the approval stage; refuses while any required gate is unmet.
pub fn approve_stage(
    run: &WorkflowRun,
    approval_node_id: &str,
    actor: &str,
    at: &str,
    policy: Option<&WorkflowPolicyProfile>,
    now: Option<DateTime<Utc>>,
) -> Result<GateActionResult, String> {
    if actor.trim().is_empty() {
        return Err("An approval must record who granted it.".to_string());
    }
    let readiness = approval_readiness(run, approval_node_id, policy, now);
    if !readiness.can_approve {
        let parts: Vec<String> = readiness
            .blocking
            .iter()
            .map(|g| format!("{} {} — {}", g.gate.as_str(), g.state.as_str(), g.detail))
            .collect();
        return Ok(refused(
            run,
            format!("Approval is blocked: {}", parts.join(" ")),
        ));
    }
    let mut next = run.clone();
    for gate in readiness
        .gates
        .iter()
        .filter(|g| g.state == GateState::Passed)
    {
        let assessed = gate
            .node_id
            .as_deref()
            .and_then(|id| find_snapshot(&next, id))
            .map(|s| s.reference);
        let decision = WorkflowGateDecision {
            gate: gate.gate,
            node_id: gate
                .node_id
                .clone()
                .unwrap_or_else(|| approval_node_id.to_string()),
            passed: true,
            bypassed: false,
            bypassed_by: None,
            reason: None,
            assessed_snapshot_ref: assessed,
            decided_at: at.to_string(),
        };
        next = apply_command(
            next,
            &WorkflowRunCommand::GateDecided {
                at: at.to_string(),
                decision,
            },
        );
    }
    next = apply_command(
        next,
        &WorkflowRunCommand::NodeStarted {
            node_id: approval_node_id.to_string(),
            at: at.to_string(),
            session_id: None,
        },
    );
    next = apply_command(next, &succeeded(approval_node_id, at));
    Ok(GateActionResult {
        run: next,
        ok: true,
        reason: None,
    })
}

fn succeeded(node_id: &str, at: &str) -> WorkflowRunCommand {
    WorkflowRunCommand::NodeSucceeded {
        node_id: node_id.to_string(),
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
    }
}

/// Rejects at an approval stage, failing the branch with an attributed reason.
pub fn reject_stage(
    run: &WorkflowRun,
    approval_node_id: &str,
    actor: &str,
    reason: &str,
    at: &str,
) -> Result<WorkflowRun, String> {
    if actor.trim().is_empty() {
        return Err("A rejection must record who made it.".to_string());
    }
    if reason.trim().is_empty() {
        return Err("A rejection must record why.".to_string());
    }
    let started = apply_command(
        run.clone(),
        &WorkflowRunCommand::NodeStarted {
            node_id: approval_node_id.to_string(),
            at: at.to_string(),
            session_id: None,
        },
    );
    Ok(apply_command(
        started,
        &WorkflowRunCommand::NodeFailed {
            node_id: approval_node_id.to_string(),
            at: at.to_string(),
            error: format!("Rejected by {actor}: {reason}"),
            exit_code: None,
            findings: None,
            pause: None,
            provider: None,
            model: None,
            independence: None,
            map_items: None,
            conflict_files: None,
        },
    ))
}

/// Skips an optional approval: everything after it is skipped and the run finishes on the
/// stages that did run.
pub fn skip_approval(
    run: &WorkflowRun,
    approval_node_id: &str,
    actor: &str,
    at: &str,
) -> Result<GateActionResult, String> {
    if actor.trim().is_empty() {
        return Err("A skip must record who made it.".to_string());
    }
    let Some(node) = approval_of(run, approval_node_id) else {
        return Ok(refused(
            run,
            format!("No approval stage \"{approval_node_id}\"."),
        ));
    };
    if node.optional != Some(true) {
        return Ok(refused(
            run,
            format!(
                "\"{}\" is a sign-off and cannot be skipped.",
                node.base.name
            ),
        ));
    }
    if run.nodes.get(approval_node_id).map(|s| s.outcome) != Some(WorkflowNodeOutcome::Pending) {
        return Ok(refused(
            run,
            format!("\"{}\" is not waiting for a decision.", node.base.name),
        ));
    }
    Ok(GateActionResult {
        run: apply_command(
            run.clone(),
            &WorkflowRunCommand::NodeSkipped {
                node_id: approval_node_id.to_string(),
                at: at.to_string(),
                reason: format!("skipped by {actor}"),
            },
        ),
        ok: true,
        reason: None,
    })
}
