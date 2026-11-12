//! The run monitor's view model (`workflowRunSummary.ts` port).
//!
//! Everything the monitor renders is derived from a [`WorkflowRun`] value: a row per stage, the
//! gate ledger, parallel branches, loop history and one sentence saying why the run is where it
//! is. Rows are built over the run's own JSON so field names stay exactly those the TypeScript
//! engine stored and the renderer reads.

use std::collections::{BTreeMap, BTreeSet};

use praxis_workflows::edges::{
    PendingLoopKind, dag_edges, describe_findings_predicate, loop_statuses, pending_loop,
};
use praxis_workflows::gates::{GateState, approval_readiness};
use praxis_workflows::recovery::{next_actions, outstanding_nodes};
use praxis_workflows::run::{
    WorkflowPauseReason, WorkflowRun, best_iteration, downstream_node_ids, exhausted_providers,
    is_paused_node, is_run_settled, pause_reason_of,
};
use praxis_workflows::scheduler::{derive_run_status, schedule_workflow_run};
use praxis_workflows::types::{WorkflowNode, WorkflowPolicyProfile};
use serde_json::{Map, Value, json};

/// The session-store key of one stage (`stageSessionKey`).
#[must_use]
pub fn stage_session_key(run_id: &str, node_id: &str) -> String {
    let prefix: String = run_id.chars().take(8).collect();
    format!("WF-{}-{node_id}", prefix.to_uppercase())
}

fn type_name(node: &WorkflowNode) -> &'static str {
    match node {
        WorkflowNode::AgentTask(_) => "agent-task",
        WorkflowNode::Check(_) => "check",
        WorkflowNode::Deployment(_) => "deployment",
        WorkflowNode::Approval(_) => "approval",
        WorkflowNode::Join(_) => "join",
        WorkflowNode::Merge(_) => "merge",
        WorkflowNode::Map(_) => "map",
    }
}

fn node_gate(node: &WorkflowNode) -> Option<String> {
    let value = match node {
        WorkflowNode::AgentTask(n) => n.satisfies_gate,
        WorkflowNode::Check(n) => n.satisfies_gate,
        WorkflowNode::Deployment(n) => n.satisfies_gate,
        WorkflowNode::Map(n) => n.satisfies_gate,
        _ => None,
    };
    value.map(|g| g.as_str().to_string())
}

fn provider_display_name(id: &str) -> String {
    praxis_ai::providers::registry::built_in_descriptors()
        .into_iter()
        .find(|d| d.id == id)
        .map_or_else(|| id.to_string(), |d| d.label)
}

fn put(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value.filter(|v| !v.is_null()) {
        map.insert(key.to_string(), value);
    }
}

fn top_findings(findings: &[Value]) -> Vec<Value> {
    let rank = |severity: &str| match severity {
        "critical" => 4,
        "high" => 3,
        "medium" => 2,
        "low" => 1,
        _ => 0,
    };
    let mut kept: Vec<&Value> = findings
        .iter()
        .filter(|f| f.get("verdict").and_then(Value::as_str) != Some("refuted"))
        .collect();
    kept.sort_by_key(|f| std::cmp::Reverse(rank(f["severity"].as_str().unwrap_or(""))));
    kept.into_iter()
        .take(5)
        .map(|f| {
            let mut row = Map::new();
            row.insert("severity".into(), f["severity"].clone());
            row.insert("message".into(), f["message"].clone());
            put(&mut row, "file", f.get("file").cloned());
            put(&mut row, "line", f.get("line").cloned());
            Value::Object(row)
        })
        .collect()
}

/// Loop edges as the run view reads them.
pub fn summarize_loops(run: &WorkflowRun) -> Vec<Value> {
    let pending = pending_loop(run);
    let name = |id: &str| {
        run.definition
            .nodes
            .iter()
            .find(|n| n.base().id == id)
            .map_or_else(|| id.to_string(), |n| n.base().name.clone())
    };
    let history_all = run.loop_history.as_deref().unwrap_or_default();
    let decisions_all = run.loop_decisions.as_deref().unwrap_or_default();
    loop_statuses(run)
        .into_iter()
        .map(|status| {
            let edge = &status.edge;
            let keep_best = edge.loop_budget.as_ref().and_then(|l| l.keep_best.as_ref());
            let best =
                keep_best.and_then(|kb| best_iteration(history_all, &edge.id, kb.higher_is_better));
            let source = run.nodes.get(&edge.from);
            let current_score = keep_best
                .and_then(|kb| {
                    source
                        .and_then(|s| s.findings.as_ref())
                        .and_then(|f| f.metrics.get(&kb.metric))
                })
                .copied();
            let needs_decision = pending.as_ref().is_some_and(|(kind, p)| {
                matches!(kind, PendingLoopKind::Decide) && p.edge.id == edge.id
            });
            let history: Vec<Value> = history_all
                .iter()
                .filter(|e| e.edge_id == edge.id)
                .map(|entry| {
                    let findings = serde_json::to_value(&entry.findings).unwrap_or_default();
                    let mut row = Map::new();
                    row.insert("iteration".into(), json!(entry.iteration));
                    row.insert("at".into(), json!(entry.at));
                    row.insert("outcome".into(), json!(entry.outcome));
                    row.insert("findingCount".into(), json!(entry.finding_count));
                    row.insert(
                        "topFindings".into(),
                        json!(top_findings(
                            findings.as_array().map_or(&[][..], Vec::as_slice)
                        )),
                    );
                    put(&mut row, "error", entry.error.clone().map(Value::from));
                    put(&mut row, "score", entry.score.map(Value::from));
                    put(
                        &mut row,
                        "restoredTo",
                        entry.restored_to.clone().map(Value::from),
                    );
                    Value::Object(row)
                })
                .collect();
            let condition = match serde_json::to_value(edge.on)
                .ok()
                .as_ref()
                .and_then(Value::as_str)
            {
                Some("findings") => {
                    describe_findings_predicate(edge.when.as_ref(), run.parameters.as_ref())
                }
                Some("failure") => "the stage fails".to_string(),
                Some("always") => "every time".to_string(),
                _ => "the stage succeeds".to_string(),
            };
            let mut row = Map::new();
            row.insert("edgeId".into(), json!(edge.id));
            row.insert("fromNodeId".into(), json!(edge.from));
            row.insert("fromName".into(), json!(name(&edge.from)));
            row.insert("toNodeId".into(), json!(edge.to));
            row.insert("toName".into(), json!(name(&edge.to)));
            row.insert("on".into(), json!(edge.on));
            row.insert("condition".into(), json!(condition));
            row.insert("iterationsTaken".into(), json!(status.iterations_taken));
            row.insert("budget".into(), json!(status.budget));
            row.insert("firing".into(), json!(status.fires && !status.exhausted));
            row.insert("needsDecision".into(), json!(needs_decision));
            row.insert("history".into(), json!(history));
            if let Some(kb) = keep_best {
                let mut entry = Map::new();
                entry.insert("metric".into(), json!(kb.metric));
                entry.insert("higherIsBetter".into(), json!(kb.higher_is_better));
                if let Some(best) = best {
                    entry.insert("bestIteration".into(), json!(best.iteration));
                    put(&mut entry, "bestScore", best.score.map(Value::from));
                }
                put(&mut entry, "currentScore", current_score.map(Value::from));
                row.insert("keepBest".into(), Value::Object(entry));
            }
            if needs_decision && let Some(findings) = source.and_then(|s| s.findings.as_ref()) {
                let list = serde_json::to_value(&findings.findings).unwrap_or_default();
                row.insert(
                    "openFindings".into(),
                    json!(top_findings(list.as_array().map_or(&[][..], Vec::as_slice))),
                );
            }
            let settled = source.is_some_and(|s| {
                matches!(
                    serde_json::to_value(s.outcome)
                        .ok()
                        .as_ref()
                        .and_then(Value::as_str),
                    Some("succeeded" | "failed")
                )
            });
            if !status.fires && settled {
                let attempts = source.map_or(0, |s| s.attempts.len());
                let accepted = decisions_all.iter().any(|d| {
                    d.edge_id == edge.id
                        && serde_json::to_value(d.decision).ok() == Some(json!("accept"))
                        && d.source_attempt == attempts
                });
                let because = if status.out_of_patience {
                    "no-improvement"
                } else if accepted {
                    "accepted"
                } else {
                    "condition-met"
                };
                row.insert("stoppedBecause".into(), json!(because));
            }
            let decisions: Vec<Value> = decisions_all
                .iter()
                .filter(|d| d.edge_id == edge.id)
                .map(|d| {
                    let mut entry = Map::new();
                    entry.insert("at".into(), json!(d.at));
                    entry.insert("actor".into(), json!(d.actor));
                    entry.insert("decision".into(), json!(d.decision));
                    put(&mut entry, "reason", d.reason.clone().map(Value::from));
                    if let Some(extra) = d.extra_iterations.filter(|n| *n > 0) {
                        entry.insert("extraIterations".into(), json!(extra));
                    }
                    Value::Object(entry)
                })
                .collect();
            row.insert("decisions".into(), json!(decisions));
            Value::Object(row)
        })
        .collect()
}

/// Which pass of a loop each stage is on (the first loop in definition order wins).
fn loop_iterations_by_node(run: &WorkflowRun) -> BTreeMap<String, Value> {
    let mut by_node = BTreeMap::new();
    for status in loop_statuses(run) {
        let edge = &status.edge;
        let downstream = downstream_node_ids(run, &edge.to);
        if !downstream.contains(&edge.from) {
            continue;
        }
        for node_id in &downstream {
            if *node_id != edge.from && !downstream_node_ids(run, node_id).contains(&edge.from) {
                continue;
            }
            if by_node.contains_key(node_id) {
                continue;
            }
            by_node.insert(
                node_id.clone(),
                json!({
                    "edgeId": edge.id,
                    "iteration": (status.iterations_taken + 1).min(status.budget + 1),
                    "budget": status.budget + 1,
                }),
            );
        }
    }
    by_node
}

fn outcome_of(run: &WorkflowRun, node_id: &str) -> String {
    run.nodes
        .get(node_id)
        .and_then(|s| serde_json::to_value(s.outcome).ok())
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "pending".to_string())
}

fn lane_for(
    run: &WorkflowRun,
    node_id: &str,
    ready: &BTreeSet<&str>,
    awaiting: &BTreeSet<&str>,
) -> &'static str {
    let outcome = outcome_of(run, node_id);
    if outcome == "running" {
        return "running";
    }
    if run.nodes.get(node_id).is_some_and(is_paused_node) {
        return "paused";
    }
    match outcome.as_str() {
        "succeeded" => return "done",
        "failed" => return "failed",
        "skipped" | "cancelled" => return "skipped",
        _ => {}
    }
    if awaiting.contains(node_id) {
        "awaiting"
    } else if ready.contains(node_id) {
        "ready"
    } else {
        "idle"
    }
}

fn parse_millis(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// Builds the monitor view. Pass the composed policy so gate rows match enforcement.
#[must_use]
pub fn summarize_workflow_run(run: &WorkflowRun, policy: Option<&WorkflowPolicyProfile>) -> Value {
    let schedule = schedule_workflow_run(run);
    let ready: BTreeSet<&str> = schedule.ready.iter().map(String::as_str).collect();
    let awaiting: BTreeSet<&str> = schedule
        .awaiting_approval
        .iter()
        .map(String::as_str)
        .collect();
    let in_loop = loop_iterations_by_node(run);

    let stages: Vec<Value> = run
        .definition
        .nodes
        .iter()
        .map(|node| {
            let base = node.base();
            let state = run.nodes.get(&base.id);
            let last = state.and_then(|s| s.attempts.last());
            let duration = last.and_then(|a| {
                let (start, end) = (
                    parse_millis(&a.started_at)?,
                    parse_millis(a.ended_at.as_deref()?)?,
                );
                Some((end - start).max(0))
            });
            let mut row = Map::new();
            row.insert("nodeId".into(), json!(base.id));
            row.insert("name".into(), json!(base.name));
            row.insert("type".into(), json!(type_name(node)));
            row.insert("outcome".into(), json!(outcome_of(run, &base.id)));
            row.insert(
                "lane".into(),
                json!(lane_for(run, &base.id, &ready, &awaiting)),
            );
            let attempts = state.map_or(0, |s| s.attempts.len());
            row.insert("attempts".into(), json!(attempts));
            let revision_base = state.and_then(|s| s.revision_base).unwrap_or(0);
            row.insert(
                "attemptsThisRevision".into(),
                json!(attempts.saturating_sub(revision_base)),
            );
            let max_attempts = match node {
                WorkflowNode::AgentTask(n) => n.max_attempts,
                WorkflowNode::Check(n) => n.max_attempts,
                WorkflowNode::Deployment(n) => n.max_attempts,
                _ => None,
            };
            put(&mut row, "maxAttempts", max_attempts.map(Value::from));
            if let Some(session) = last.and_then(|a| a.session_id.as_ref()) {
                row.insert("sessionId".into(), json!(session));
                row.insert(
                    "sessionKey".into(),
                    json!(stage_session_key(&run.run_id, &base.id)),
                );
            }
            put(
                &mut row,
                "snapshotRef",
                state.and_then(|s| s.snapshot_ref.clone()).map(Value::from),
            );
            put(&mut row, "gate", node_gate(node).map(Value::from));
            if !base.inputs.is_empty() {
                row.insert("inputs".into(), json!(base.inputs));
            }
            let artifacts: Vec<Value> = state
                .map(|s| {
                    s.artifacts
                        .iter()
                        .map(|a| {
                            let value = serde_json::to_value(a).unwrap_or_default();
                            let mut out = Map::new();
                            out.insert("contractId".into(), value["contractId"].clone());
                            out.insert("kind".into(), value["kind"].clone());
                            put(&mut out, "path", value.get("path").cloned());
                            put(&mut out, "reference", value.get("reference").cloned());
                            Value::Object(out)
                        })
                        .collect()
                })
                .unwrap_or_default();
            row.insert("artifacts".into(), json!(artifacts));
            put(
                &mut row,
                "lastError",
                last.and_then(|a| a.error.clone()).map(Value::from),
            );
            put(
                &mut row,
                "pause",
                state
                    .and_then(pause_reason_of)
                    .and_then(|p| serde_json::to_value(p).ok()),
            );
            put(
                &mut row,
                "phase",
                state.and_then(|s| s.phase.clone()).map(Value::from),
            );
            put(
                &mut row,
                "findings",
                state
                    .and_then(|s| s.findings.as_ref())
                    .and_then(|f| serde_json::to_value(f).ok()),
            );
            put(
                &mut row,
                "provider",
                last.and_then(|a| a.provider.clone()).map(Value::from),
            );
            put(
                &mut row,
                "model",
                last.and_then(|a| a.model.clone()).map(Value::from),
            );
            put(
                &mut row,
                "independence",
                last.and_then(|a| a.independence.as_ref())
                    .and_then(|i| serde_json::to_value(i).ok()),
            );
            if let WorkflowNode::AgentTask(task) = node {
                let provider = run
                    .stage_providers
                    .as_ref()
                    .and_then(|m| m.get(&base.id).cloned())
                    .or_else(|| {
                        task.agent
                            .provider_id
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    });
                let model = run
                    .stage_models
                    .as_ref()
                    .and_then(|m| m.get(&base.id).cloned())
                    .or_else(|| {
                        task.model
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    });
                put(&mut row, "chosenProvider", provider.map(Value::from));
                put(&mut row, "chosenModel", model.map(Value::from));
            }
            if let WorkflowNode::Check(check) = node {
                let mut parts = vec![check.command.clone()];
                parts.extend(check.args.clone().unwrap_or_default());
                parts.retain(|p| !p.is_empty());
                if !parts.is_empty() {
                    row.insert("command".into(), json!(parts.join(" ")));
                }
            }
            put(
                &mut row,
                "exitCode",
                last.and_then(|a| a.exit_code).map(Value::from),
            );
            put(&mut row, "durationMs", duration.map(Value::from));
            put(
                &mut row,
                "startedAt",
                last.map(|a| Value::from(a.started_at.clone())),
            );
            if let WorkflowNode::Approval(approval) = node {
                row.insert("prompt".into(), json!(approval.prompt));
                row.insert("requiredGates".into(), json!(approval.required_gates));
            }
            put(&mut row, "loopIteration", in_loop.get(&base.id).cloned());
            Value::Object(row)
        })
        .collect();

    let loops = summarize_loops(run);
    let deciding = loops
        .iter()
        .find(|l| l["needsDecision"] == json!(true))
        .cloned();

    // Union across every approval node; the first evaluation of a gate wins the dedupe.
    let mut gates_by_kind: Vec<(String, Value)> = Vec::new();
    for node in &run.definition.nodes {
        let WorkflowNode::Approval(approval) = node else {
            continue;
        };
        let readiness = approval_readiness(run, &approval.base.id, policy, None);
        let bypassable: BTreeSet<String> = readiness
            .bypassable
            .iter()
            .map(|g| g.gate.as_str().to_string())
            .collect();
        for gate in &readiness.gates {
            let kind = gate.gate.as_str().to_string();
            if gates_by_kind.iter().any(|(k, _)| *k == kind) {
                continue;
            }
            let is_bypassable = bypassable.contains(&kind);
            let unresolved = !matches!(
                gate.state,
                GateState::Pending | GateState::Passed | GateState::Bypassed
            );
            let mut value = serde_json::to_value(gate).unwrap_or_default();
            value["bypassable"] = json!(is_bypassable);
            value["approvalNodeId"] = json!(approval.base.id);
            if !is_bypassable && approval.allow_bypass && unresolved {
                value["bypassBlockedByPolicy"] = json!(true);
            }
            gates_by_kind.push((kind, value));
        }
    }
    let gates: Vec<Value> = gates_by_kind.into_iter().map(|(_, v)| v).collect();

    let status = derive_run_status(run);
    let status_text = serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let explanation = explain_run(
        run,
        &status_text,
        schedule.blocked.as_deref(),
        &gates,
        &loops,
    );

    let nodes_graph: Vec<Value> = run
        .definition
        .nodes
        .iter()
        .map(|n| {
            let b = n.base();
            json!({ "id": b.id, "x": b.x, "y": b.y, "type": type_name(n) })
        })
        .collect();

    let mut summary = Map::new();
    summary.insert("runId".into(), json!(run.run_id));
    summary.insert("projectId".into(), json!(run.project_id));
    summary.insert("workflowId".into(), json!(run.workflow_id));
    summary.insert(
        "workflowName".into(),
        json!(
            run.display_name
                .clone()
                .unwrap_or_else(|| run.definition.name.clone())
        ),
    );
    summary.insert("status".into(), json!(status_text));
    summary.insert("explanation".into(), json!(explanation));
    summary.insert("stages".into(), json!(stages));
    summary.insert(
        "graph".into(),
        json!({
            "nodes": nodes_graph,
            "edges": run.definition.edges,
            "entryNodeId": run.definition.entry_node_id,
        }),
    );
    summary.insert("gates".into(), json!(gates));
    summary.insert("branchGroups".into(), json!(branch_groups(run)));
    summary.insert(
        "actions".into(),
        serde_json::to_value(next_actions(run, None)).unwrap_or_else(|_| json!([])),
    );
    let any_paused = stages.iter().any(|s| s["lane"] == "paused");
    let any_running = stages.iter().any(|s| s["lane"] == "running");
    if status_text == "running" && any_paused && !any_running {
        summary.insert("paused".into(), json!(true));
        let environment = stages.iter().any(|s| s["pause"] == "environment");
        summary.insert(
            "pauseReason".into(),
            json!(if environment {
                "environment"
            } else {
                "provider-limit"
            }),
        );
    }
    summary.insert("outstanding".into(), json!(outstanding_nodes(run)));
    summary.insert("events".into(), json!(run.events));
    summary.insert("startedAt".into(), json!(run.started_at));
    put(
        &mut summary,
        "endedAt",
        run.ended_at.clone().map(Value::from),
    );
    put(
        &mut summary,
        "issueKey",
        run.issue_key.clone().map(Value::from),
    );
    put(
        &mut summary,
        "controllerSessionKey",
        run.controller_session_key.clone().map(Value::from),
    );
    put(
        &mut summary,
        "controllerSessionId",
        run.controller_session_id.clone().map(Value::from),
    );
    put(
        &mut summary,
        "planInput",
        run.plan_input
            .as_ref()
            .and_then(|p| serde_json::to_value(p).ok()),
    );
    put(
        &mut summary,
        "aiProvider",
        run.ai_provider.clone().map(Value::from),
    );
    put(
        &mut summary,
        "aiModel",
        run.ai_model.clone().map(Value::from),
    );
    if run.archived == Some(true) {
        summary.insert("archived".into(), json!(true));
        put(
            &mut summary,
            "archivedAt",
            run.archived_at.clone().map(Value::from),
        );
    }
    let auto = run
        .permission_mode
        .and_then(|m| serde_json::to_value(m).ok())
        .is_some_and(|v| v == "auto");
    summary.insert(
        "permissionMode".into(),
        json!(if auto { "auto" } else { "ask" }),
    );
    summary.insert(
        "providerLimitPolicy".into(),
        run.provider_limit_policy
            .and_then(|p| serde_json::to_value(p).ok())
            .unwrap_or_else(|| json!("ask")),
    );
    summary.insert("exhaustedProviders".into(), json!(exhausted_providers(run)));
    summary.insert("loops".into(), json!(loops));
    if let (Some(deciding), Some(blocked)) = (deciding, schedule.blocked.as_ref()) {
        summary.insert(
            "needsDecision".into(),
            json!({ "edgeId": deciding["edgeId"], "message": blocked }),
        );
    }
    put(
        &mut summary,
        "parameters",
        run.parameters
            .as_ref()
            .and_then(|p| serde_json::to_value(p).ok()),
    );
    Value::Object(summary)
}

/// The parallel branches feeding each join, and whether they have converged.
fn branch_groups(run: &WorkflowRun) -> Vec<Value> {
    run.definition
        .nodes
        .iter()
        .filter_map(|node| match node {
            WorkflowNode::Join(join) => Some(join),
            _ => None,
        })
        .map(|join| {
            let branches: Vec<Value> = dag_edges(&run.definition)
                .filter(|edge| edge.to == join.base.id)
                .map(|edge| {
                    let head = run.definition.nodes.iter().find(|n| n.base().id == edge.from);
                    json!({
                        "headNodeId": edge.from,
                        "headName": head.map_or_else(|| edge.from.clone(), |n| n.base().name.clone()),
                        "outcome": outcome_of(run, &edge.from),
                        "required": edge.required,
                    })
                })
                .collect();
            json!({
                "joinNodeId": join.base.id,
                "joinName": join.base.name,
                "converged": outcome_of(run, &join.base.id) == "succeeded",
                "branches": branches,
            })
        })
        .collect()
}

fn node_name(run: &WorkflowRun, id: &str) -> String {
    run.definition
        .nodes
        .iter()
        .find(|n| n.base().id == id)
        .map_or_else(|| id.to_string(), |n| n.base().name.clone())
}

fn explain_run(
    run: &WorkflowRun,
    status: &str,
    blocked: Option<&str>,
    gates: &[Value],
    loops: &[Value],
) -> String {
    if status == "succeeded" {
        let short = loops.iter().find(|l| {
            matches!(
                l["stoppedBecause"].as_str(),
                Some("accepted" | "no-improvement")
            )
        });
        if let Some(short) = short {
            let best = match (
                short["keepBest"]["bestScore"].as_f64(),
                short["keepBest"]["metric"].as_str(),
            ) {
                (Some(score), Some(metric)) => format!(
                    " The best {metric} was {score} (iteration {}).",
                    short["keepBest"]["bestIteration"]
                ),
                _ => String::new(),
            };
            let improving = if short["stoppedBecause"] == "no-improvement" {
                " improving"
            } else {
                ""
            };
            return format!(
                "The run completed, but the target was not reached: {} still matched \"{}\" when it stopped{improving}.{best}",
                short["fromName"].as_str().unwrap_or(""),
                short["condition"].as_str().unwrap_or("")
            );
        }
        return "The run completed: every required stage passed and approval was granted.".into();
    }
    let reason = |prefix: &str| match &run.ended_reason {
        Some(r) => format!("{prefix}: {r}"),
        None => format!("{prefix}."),
    };
    if status == "cancelled" {
        return reason("The run was cancelled");
    }
    if status == "failed" {
        return reason("The run failed");
    }

    let sorted_names = |ids: Vec<&String>| {
        let mut names: Vec<String> = ids.into_iter().map(|id| node_name(run, id)).collect();
        names.sort();
        names
    };
    let running: Vec<&String> = run
        .nodes
        .iter()
        .filter(|(_, s)| serde_json::to_value(s.outcome).ok() == Some(json!("running")))
        .map(|(id, _)| id)
        .collect();
    if !running.is_empty() {
        let names = sorted_names(running);
        return format!(
            "{} in progress: {}.",
            if names.len() == 1 { "Stage" } else { "Stages" },
            names.join(", ")
        );
    }

    if status == "awaiting-approval" {
        let failing: Vec<String> = gates
            .iter()
            .filter(|g| !matches!(g["state"].as_str(), Some("passed" | "bypassed")))
            .map(|g| {
                format!(
                    "{} {}",
                    g["gate"].as_str().unwrap_or(""),
                    g["state"].as_str().unwrap_or("")
                )
            })
            .collect();
        return if failing.is_empty() {
            "Every required gate has resolved; the run is waiting for a human approval.".into()
        } else {
            format!(
                "The run reached approval, but it cannot be approved: {}.",
                failing.join(", ")
            )
        };
    }

    if let (Some(_), Some(blocked)) = (pending_loop(run), blocked) {
        return blocked.to_string();
    }

    let paused: Vec<(&String, &praxis_workflows::run::WorkflowNodeState)> = run
        .nodes
        .iter()
        .filter(|(_, s)| is_paused_node(s))
        .collect();
    if !paused.is_empty() {
        let names = sorted_names(paused.iter().map(|(id, _)| *id).collect());
        let environment = paused
            .iter()
            .any(|(_, s)| pause_reason_of(s) == Some(WorkflowPauseReason::Environment));
        if environment {
            return format!(
                "{} could not run in this environment — for example a registry that does not serve the request, a missing command, or no network. Fix that, then retry; nothing is lost and no attempt was used.",
                names.join(", ")
            );
        }
        let mut ais: Vec<String> = Vec::new();
        for (_, state) in &paused {
            if let Some(p) = state.attempts.last().and_then(|a| a.provider.clone())
                && !ais.contains(&p)
            {
                ais.push(p);
            }
        }
        let who = if ais.is_empty() {
            "The AI provider".to_string()
        } else {
            ais.iter()
                .map(|id| provider_display_name(id))
                .collect::<Vec<_>>()
                .join(" and ")
        };
        return format!(
            "{who} ran out of credits or hit its usage limit at {}. Switch to another AI, or restore them and retry — nothing is lost and no attempt was used.",
            names.join(", ")
        );
    }

    let failed: Vec<&String> = run
        .nodes
        .iter()
        .filter(|(_, s)| serde_json::to_value(s.outcome).ok() == Some(json!("failed")))
        .map(|(id, _)| id)
        .collect();
    if !failed.is_empty() {
        return format!(
            "{} failed and can be retried or the run cancelled.",
            sorted_names(failed).join(", ")
        );
    }
    if let Some(blocked) = blocked {
        return blocked.to_string();
    }
    if is_run_settled(run) {
        "The run has ended.".into()
    } else {
        "Waiting for the next stage to be dispatched.".into()
    }
}
