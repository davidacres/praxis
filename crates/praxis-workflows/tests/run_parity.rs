//! Differential parity with the TypeScript workflow engine.
//!
//! `parity/run-parity.json.gz` holds seeded random operation sequences that
//! `parity/generate-run-parity.mjs` drove through the TS engine, with the schedule,
//! derived status, pending loop, retryable stages, stage providers, gate evaluation (with
//! and without a policy), next actions, timeouts, and failing findings after every step
//! (stored when they changed) and the final run. This replays every operation through
//! the Rust engine and requires identical results at each recorded step.

use std::io::Read;

use flate2::read::GzDecoder;
use praxis_workflows::edges::{PendingLoopKind, pending_loop};
use praxis_workflows::gates::{
    GateBypassInput, approval_readiness, approve_stage, bypass_gate, evaluate_gates,
    failing_gate_findings, reject_stage, repair_stage_for_findings, skip_approval,
};
use praxis_workflows::recovery::{find_timed_out_nodes, next_actions, recover_workflow_run};
use praxis_workflows::run::{
    CreateWorkflowRunInput, RevisionFindingItem, ReworkOptions, WorkflowRun, WorkflowRunCommand,
    allow_ai_merge_resolution, apply_command, can_retry, create_workflow_run,
    normalize_workflow_run, rework_workflow_run, stage_provider,
};
use praxis_workflows::scheduler::{advance_joins, derive_run_status, schedule_workflow_run};
use praxis_workflows::types::{WorkflowDefinition, WorkflowNode, WorkflowPolicyProfile};
use serde_json::{Value, json};

fn fixture() -> Value {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/parity/run-parity.json.gz"
    ))
    .expect("read parity fixture");
    let mut text = String::new();
    GzDecoder::new(bytes.as_slice())
        .read_to_string(&mut text)
        .expect("gunzip parity fixture");
    serde_json::from_str(&text).expect("parse parity fixture")
}

/// JSON with every number as a float, so `0` (JS) and `0.0` (an `f64` field) compare equal.
fn canonical(value: Value) -> Value {
    match value {
        Value::Number(n) => n
            .as_f64()
            .and_then(serde_json::Number::from_f64)
            .map_or(Value::Number(n), Value::Number),
        Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, canonical(v))).collect())
        }
        other => other,
    }
}

fn str_field(value: &Value, name: &str) -> Option<String> {
    value.get(name).and_then(Value::as_str).map(str::to_string)
}

fn create(definition: &WorkflowDefinition, spec: &Value) -> WorkflowRun {
    let mut input = CreateWorkflowRunInput::new(
        spec["runId"].as_str().expect("runId"),
        spec["projectId"].as_str().expect("projectId"),
        definition.clone(),
        spec["at"].as_str().expect("at"),
    );
    input.permission_mode = spec
        .get("permissionMode")
        .map(|v| serde_json::from_value(v.clone()).expect("mode"));
    input.ai_provider = str_field(spec, "aiProvider");
    input.ai_model = str_field(spec, "aiModel");
    input.provider_limit_policy = spec
        .get("providerLimitPolicy")
        .map(|v| serde_json::from_value(v.clone()).expect("policy"));
    input.issue_key = str_field(spec, "issueKey");
    input.parameters = spec
        .get("parameters")
        .map(|v| serde_json::from_value(v.clone()).expect("parameters"));
    create_workflow_run(input)
}

fn apply(run: WorkflowRun, operation: &Value, policy: &WorkflowPolicyProfile) -> WorkflowRun {
    let at = || operation["at"].as_str().expect("at").to_string();
    let text = |name: &str| operation[name].as_str().expect(name).to_string();
    let policy_for = || (operation["policy"] == Value::Bool(true)).then_some(policy);
    match operation["op"].as_str().expect("op") {
        "command" => {
            let command: WorkflowRunCommand =
                serde_json::from_value(operation["command"].clone()).expect("command deserializes");
            apply_command(run, &command)
        }
        "advanceJoins" => advance_joins(run, &at()),
        "rework" => {
            let raw = &operation["options"];
            let options = ReworkOptions {
                rerun_source: raw.get("rerunSource").and_then(Value::as_bool),
                reset_node_ids: Vec::new(),
                by_person: raw
                    .get("byPerson")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                fresh_attempts: raw
                    .get("freshAttempts")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                carry_findings: raw
                    .get("carryFindings")
                    .map(|v| {
                        serde_json::from_value::<Vec<RevisionFindingItem>>(v.clone())
                            .expect("carry")
                    })
                    .unwrap_or_default(),
            };
            rework_workflow_run(
                &run,
                operation["nodeId"].as_str().expect("nodeId"),
                &at(),
                &options,
            )
            .run
        }
        "allowAiMergeResolution" => {
            allow_ai_merge_resolution(&run, operation["nodeId"].as_str().expect("nodeId"), &at())
                .unwrap_or(run)
        }
        "normalize" => normalize_workflow_run(&serde_json::to_value(&run).expect("serialize"))
            .expect("normalizes"),
        "approve" => {
            approve_stage(
                &run,
                &text("nodeId"),
                &text("actor"),
                &at(),
                policy_for(),
                None,
            )
            .expect("approve input is valid")
            .run
        }
        "bypass" => {
            let input = GateBypassInput {
                gate: serde_json::from_value(operation["gate"].clone()).expect("gate"),
                actor: text("actor"),
                reason: text("reason"),
                at: at(),
            };
            bypass_gate(&run, &text("nodeId"), &input, policy_for(), None)
                .expect("bypass input is valid")
                .run
        }
        "reject" => reject_stage(
            &run,
            &text("nodeId"),
            &text("actor"),
            &text("reason"),
            &at(),
        )
        .expect("reject input is valid"),
        "skipApproval" => {
            skip_approval(&run, &text("nodeId"), &text("actor"), &at())
                .expect("skip input is valid")
                .run
        }
        "recover" => recover_workflow_run(run, &at()).run,
        other => panic!("unknown operation {other}"),
    }
}

fn observe(run: &WorkflowRun, policy: &WorkflowPolicyProfile, timeout_now: &str) -> Value {
    let loop_state = pending_loop(run).map(|(kind, status)| {
        json!({
            "kind": if kind == PendingLoopKind::Take { "take" } else { "decide" },
            "edgeId": status.edge.id,
            "budget": status.budget,
            "taken": status.iterations_taken,
        })
    });
    let ids: Vec<&String> = run.nodes.keys().collect();
    json!({
        "schedule": schedule_workflow_run(run),
        "status": derive_run_status(run),
        "events": run.events.len(),
        "pendingLoop": loop_state,
        "canRetry": ids.iter().filter(|id| can_retry(run, id)).collect::<Vec<_>>(),
        "stageProvider": ids.iter().map(|id| stage_provider(run, id, "fallback-ai")).collect::<Vec<_>>(),
        "gates": run.definition.nodes.iter().filter(|n| matches!(n, WorkflowNode::Approval(_))).map(|n| json!({
            "approval": n.id(),
            "plain": evaluate_gates(run, n.id(), None, None, None),
            "withPolicy": approval_readiness(run, n.id(), Some(policy), None),
        })).collect::<Vec<_>>(),
        "nextActions": next_actions(run, None),
        "timedOut": find_timed_out_nodes(run, timeout_now),
        "failingFindings": failing_gate_findings(run, Some(policy), None),
        "repairStage": repair_stage_for_findings(run, &failing_gate_findings(run, Some(policy), None)),
    })
}

fn first_difference(path: &str, expected: &Value, actual: &Value) -> Option<String> {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            for key in e.keys().chain(a.keys()) {
                let (ev, av) = (
                    e.get(key).unwrap_or(&Value::Null),
                    a.get(key).unwrap_or(&Value::Null),
                );
                if let Some(diff) = first_difference(&format!("{path}.{key}"), ev, av) {
                    return Some(diff);
                }
            }
            None
        }
        (Value::Array(e), Value::Array(a)) if e.len() == a.len() => e
            .iter()
            .zip(a)
            .enumerate()
            .find_map(|(i, (ev, av))| first_difference(&format!("{path}[{i}]"), ev, av)),
        _ if expected == actual => None,
        _ => Some(format!("{path}: expected {expected}, got {actual}")),
    }
}

#[test]
fn rust_engine_matches_typescript_engine_step_by_step() {
    let fixture = fixture();
    let definitions: Vec<WorkflowDefinition> =
        serde_json::from_value(fixture["definitions"].clone()).expect("definitions deserialize");
    let scenarios = fixture["scenarios"].as_array().expect("scenarios");
    let policy: WorkflowPolicyProfile =
        serde_json::from_value(fixture["policy"].clone()).expect("policy deserializes");
    let timeout_now = fixture["timeoutNow"].as_str().expect("timeoutNow");
    assert!(scenarios.len() >= 40, "fixture has too few scenarios");

    let mut failures = Vec::new();
    let mut checked_steps = 0;
    for scenario in scenarios {
        let seed = &scenario["seed"];
        let definition = definitions
            .iter()
            .find(|d| Some(d.id.as_str()) == scenario["definition"].as_str())
            .expect("scenario definition");
        let mut run = create(definition, &scenario["create"]);
        let mut failed = false;
        for (index, step) in scenario["steps"]
            .as_array()
            .expect("steps")
            .iter()
            .enumerate()
        {
            run = apply(run, &step["operation"], &policy);
            let Some(expected) = step.get("observation") else {
                continue;
            };
            checked_steps += 1;
            if let Some(diff) = first_difference(
                "",
                &canonical(expected.clone()),
                &canonical(observe(&run, &policy, timeout_now)),
            ) {
                failures.push(format!(
                    "seed {seed} step {} ({}): {diff}",
                    index + 1,
                    step["operation"]
                ));
                failed = true;
                break;
            }
        }
        if failed {
            continue;
        }
        let mut actual = serde_json::to_value(&run).expect("serialize run");
        actual
            .as_object_mut()
            .expect("run object")
            .remove("definition");
        if let Some(diff) = first_difference(
            "run",
            &canonical(scenario["final"].clone()),
            &canonical(actual),
        ) {
            failures.push(format!("seed {seed} final: {diff}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} scenarios diverged ({checked_steps} steps checked):\n{}",
        failures.len(),
        scenarios.len(),
        failures
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
