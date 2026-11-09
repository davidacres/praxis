//! Workflow Bridge connecting `crates/praxis-workflows` into `praxis-host` RPC channels.
//!
//! Provides pure and deterministic workflow execution, status derivation, scheduling,
//! gate approval/rejection/bypass evaluation, rework, retry, and cron computation.

use chrono::{SecondsFormat, Utc};
use praxis_contracts::RustRpcError;
use praxis_workflows::cron_scheduler::CronSchedule;
use praxis_workflows::gates::{
    GateActionResult, GateBypassInput, GateStatus, approve_stage, bypass_gate, evaluate_gates,
    reject_stage,
};
use praxis_workflows::run::{
    CreateWorkflowRunInput, ReworkOptions, WorkflowRun, WorkflowRunCommand, WorkflowRunStatus,
    apply_workflow_run_command, can_retry, create_workflow_run, rework_workflow_run,
};
use praxis_workflows::scheduler::{advance_joins, derive_run_status, schedule_workflow_run};
use praxis_workflows::types::{WorkflowGateKind, WorkflowPolicyProfile, WorkflowScope};
use praxis_workflows::waivers::{FindingWaiver, parse_iso_date};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::HostContext;

/// Type alias for workflow policies.
pub type WorkflowPolicy = WorkflowPolicyProfile;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn failure(message: impl std::fmt::Display) -> RustRpcError {
    RustRpcError {
        code: "WORKFLOW_BRIDGE_ERROR".into(),
        message: message.to_string(),
    }
}

/// Details for granting or rejecting a workflow stage approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageApproval {
    pub actor: String,
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// DTO result of an approval, rejection, or gate bypass action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateActionResultDto {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<WorkflowRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl From<GateActionResult> for GateActionResultDto {
    fn from(res: GateActionResult) -> Self {
        Self {
            ok: res.ok,
            run: Some(res.run),
            reason: res.reason,
        }
    }
}

/// Result returned from evaluating gate conditions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateEvaluationResult {
    pub gates: Vec<GateStatus>,
}

impl From<Vec<GateStatus>> for GateEvaluationResult {
    fn from(gates: Vec<GateStatus>) -> Self {
        Self { gates }
    }
}

fn parse_arg<T: for<'de> Deserialize<'de>>(
    args: &[Value],
    index: usize,
    name: &str,
) -> Result<T, RustRpcError> {
    let val = args
        .get(index)
        .ok_or_else(|| failure(format!("Missing argument '{name}' at index {index}.")))?;
    serde_json::from_value(val.clone())
        .map_err(|e| failure(format!("Invalid argument '{name}' at index {index}: {e}")))
}

fn parse_optional_arg<T: for<'de> Deserialize<'de>>(
    args: &[Value],
    index: usize,
) -> Result<Option<T>, RustRpcError> {
    match args.get(index) {
        None | Some(Value::Null) => Ok(None),
        Some(val) => serde_json::from_value(val.clone())
            .map(Some)
            .map_err(|e| failure(format!("Invalid optional argument at index {index}: {e}"))),
    }
}

fn parse_string_arg(args: &[Value], index: usize, name: &str) -> Result<String, RustRpcError> {
    match args.get(index) {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(val) => serde_json::from_value(val.clone()).map_err(|e| {
            failure(format!(
                "Invalid string argument '{name}' at index {index}: {e}"
            ))
        }),
        None => Err(failure(format!(
            "Missing string argument '{name}' at index {index}."
        ))),
    }
}

fn parse_stage_approval(args: &[Value], index: usize) -> Result<StageApproval, RustRpcError> {
    match args.get(index) {
        Some(Value::String(actor)) => Ok(StageApproval {
            actor: actor.clone(),
            at: None,
            note: None,
            reason: None,
        }),
        Some(val @ Value::Object(_)) => serde_json::from_value(val.clone())
            .map_err(|e| failure(format!("Invalid StageApproval at index {index}: {e}"))),
        Some(_) => Err(failure(format!(
            "Expected StageApproval object or string actor at index {index}."
        ))),
        None => Err(failure(format!(
            "Missing StageApproval argument at index {index}."
        ))),
    }
}

fn parse_gate_kind(s: &str) -> Result<WorkflowGateKind, RustRpcError> {
    match s.trim().to_lowercase().as_str() {
        "review" => Ok(WorkflowGateKind::Review),
        "qa" => Ok(WorkflowGateKind::Qa),
        "security" => Ok(WorkflowGateKind::Security),
        other => serde_json::from_value(Value::String(other.to_string()))
            .map_err(|e| failure(format!("Invalid gate kind '{other}': {e}"))),
    }
}

fn to_json_value<T: Serialize>(value: T) -> Result<Value, RustRpcError> {
    serde_json::to_value(value).map_err(|e| failure(format!("Serialization error: {e}")))
}

/// Registers workflow bridge RPC channels onto the given [`HostContext`].
pub fn register_workflow_channels(host: &HostContext) {
    // 1. workflows:createRun
    host.register_handler("workflows:createRun", |_ctx, args| {
        let input: CreateWorkflowRunInput = parse_arg(args, 0, "CreateWorkflowRunInput")?;
        let run = create_workflow_run(input);
        to_json_value(run)
    });

    // 2. workflows:applyCommand
    host.register_handler("workflows:applyCommand", |_ctx, args| {
        let run: WorkflowRun = parse_arg(args, 0, "WorkflowRun")?;
        let command: WorkflowRunCommand = parse_arg(args, 1, "WorkflowRunCommand")?;
        let updated = apply_workflow_run_command(&run, &command).unwrap_or(run);
        to_json_value(updated)
    });

    // 3. workflows:schedule
    host.register_handler("workflows:schedule", |_ctx, args| {
        let run: WorkflowRun = parse_arg(args, 0, "WorkflowRun")?;
        let schedule = schedule_workflow_run(&run);
        to_json_value(schedule)
    });

    // 4. workflows:advanceJoins
    host.register_handler("workflows:advanceJoins", |_ctx, args| {
        let run: WorkflowRun = parse_arg(args, 0, "WorkflowRun")?;
        let at = match args.get(1) {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => now_iso(),
        };
        let updated = advance_joins(run, &at);
        to_json_value(updated)
    });

    // 5. workflows:deriveStatus
    host.register_handler("workflows:deriveStatus", |_ctx, args| {
        let run: WorkflowRun = parse_arg(args, 0, "WorkflowRun")?;
        let status: WorkflowRunStatus = derive_run_status(&run);
        to_json_value(status)
    });

    // 6. workflows:approveStage
    host.register_handler("workflows:approveStage", |_ctx, args| {
        let run: WorkflowRun = parse_arg(args, 0, "WorkflowRun")?;
        let stage_id = parse_string_arg(args, 1, "stage_id")?;
        let approval = parse_stage_approval(args, 2)?;
        let policy: Option<WorkflowPolicy> = parse_optional_arg(args, 3)?;
        let now = now_iso();
        let at = approval.at.as_deref().unwrap_or(&now);

        let result =
            match approve_stage(&run, &stage_id, &approval.actor, at, policy.as_ref(), None) {
                Ok(res) => GateActionResultDto::from(res),
                Err(reason) => GateActionResultDto {
                    ok: false,
                    run: None,
                    reason: Some(reason),
                },
            };
        to_json_value(result)
    });

    // 7. workflows:rejectStage
    host.register_handler("workflows:rejectStage", |_ctx, args| {
        let run: WorkflowRun = parse_arg(args, 0, "WorkflowRun")?;
        let stage_id = parse_string_arg(args, 1, "stage_id")?;
        let rejection = parse_stage_approval(args, 2)?;
        let now = now_iso();
        let at = rejection.at.as_deref().unwrap_or(&now);
        let reason = rejection
            .reason
            .as_deref()
            .or(rejection.note.as_deref())
            .unwrap_or("Rejected");

        let result = match reject_stage(&run, &stage_id, &rejection.actor, reason, at) {
            Ok(updated) => GateActionResultDto {
                ok: true,
                run: Some(updated),
                reason: None,
            },
            Err(err) => GateActionResultDto {
                ok: false,
                run: None,
                reason: Some(err),
            },
        };
        to_json_value(result)
    });

    // 8. workflows:bypassGate
    host.register_handler("workflows:bypassGate", |_ctx, args| {
        let run: WorkflowRun = parse_arg(args, 0, "WorkflowRun")?;
        let stage_id = parse_string_arg(args, 1, "stage_id")?;
        let gate_str = parse_string_arg(args, 2, "gate")?;
        let actor = parse_string_arg(args, 3, "actor")?;
        let reason = parse_string_arg(args, 4, "reason")?;

        let mut at = now_iso();
        let mut policy: Option<WorkflowPolicy> = None;

        if let Some(arg5) = args.get(5) {
            if let Some(s) = arg5.as_str() {
                at = s.to_string();
                if let Some(arg6) = args.get(6) {
                    policy = serde_json::from_value(arg6.clone()).ok();
                }
            } else if arg5.is_object() {
                policy = serde_json::from_value(arg5.clone()).ok();
            }
        }

        let gate = parse_gate_kind(&gate_str)?;
        let bypass_input = GateBypassInput {
            gate,
            actor,
            reason,
            at,
        };

        let result = match bypass_gate(&run, &stage_id, &bypass_input, policy.as_ref(), None) {
            Ok(res) => GateActionResultDto::from(res),
            Err(err) => GateActionResultDto {
                ok: false,
                run: None,
                reason: Some(err),
            },
        };
        to_json_value(result)
    });

    // 9. workflows:evaluateGates
    host.register_handler("workflows:evaluateGates", |_ctx, args| {
        let run: WorkflowRun = parse_arg(args, 0, "WorkflowRun")?;
        let node_id = parse_string_arg(args, 1, "node_id")?;
        let policy: Option<WorkflowPolicy> = parse_optional_arg(args, 2)?;
        let active_waivers: Vec<FindingWaiver> = parse_optional_arg(args, 3)?.unwrap_or_default();

        let effective_policy = match (policy, active_waivers.is_empty()) {
            (Some(mut p), false) => {
                let mut waivers = p.waivers.take().unwrap_or_default();
                waivers.extend(active_waivers);
                p.waivers = Some(waivers);
                Some(p)
            }
            (Some(p), true) => Some(p),
            (None, false) => Some(WorkflowPolicyProfile {
                schema_version: 1,
                id: "synthetic-active-waivers".to_string(),
                name: "Active Waivers".to_string(),
                scope: WorkflowScope::Project,
                project_id: None,
                required_gates: Vec::new(),
                require_human_approval: false,
                allow_gate_bypass: false,
                require_trusted_agents: false,
                max_attempts_per_node: 1,
                gate_thresholds: None,
                waivers: Some(active_waivers),
                created_at: String::new(),
                updated_at: String::new(),
            }),
            (None, true) => None,
        };

        let gates = evaluate_gates(&run, &node_id, effective_policy.as_ref(), None, None);
        let result = GateEvaluationResult { gates };
        to_json_value(result)
    });

    // 10. workflows:rework
    host.register_handler("workflows:rework", |_ctx, args| {
        let run: WorkflowRun = parse_arg(args, 0, "WorkflowRun")?;
        let node_id = parse_string_arg(args, 1, "node_id")?;
        let at = match args.get(2) {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => now_iso(),
        };
        let _reason = args.get(3).and_then(Value::as_str);

        let options = ReworkOptions {
            by_person: true,
            ..Default::default()
        };

        let result = rework_workflow_run(&run, &node_id, &at, &options);
        if let Some(err) = result.reason {
            return Err(failure(err));
        }
        to_json_value(result.run)
    });

    // 11. workflows:canRetry
    host.register_handler("workflows:canRetry", |_ctx, args| {
        let run: WorkflowRun = parse_arg(args, 0, "WorkflowRun")?;
        let node_id = parse_string_arg(args, 1, "node_id")?;
        let retryable = can_retry(&run, &node_id);
        Ok(Value::Bool(retryable))
    });

    // 12. workflows:cronNext
    host.register_handler("workflows:cronNext", |_ctx, args| {
        let expression = parse_string_arg(args, 0, "expression")?;
        let timezone = parse_string_arg(args, 1, "timezone")?;
        let after_utc = parse_string_arg(args, 2, "after_utc")?;

        let cron = CronSchedule::new(&expression, &timezone).map_err(failure)?;
        let after_dt = parse_iso_date(&after_utc)
            .ok_or_else(|| failure(format!("Invalid after_utc timestamp: {after_utc}")))?;

        match cron.next_after(after_dt) {
            Some(next) => Ok(Value::String(
                next.to_rfc3339_opts(SecondsFormat::Millis, true),
            )),
            None => Ok(Value::Null),
        }
    });

    // 13. workflows:cronOverdue
    host.register_handler("workflows:cronOverdue", |_ctx, args| {
        let expression = parse_string_arg(args, 0, "expression")?;
        let timezone = parse_string_arg(args, 1, "timezone")?;
        let last_run: Option<String> = parse_optional_arg(args, 2)?;
        let now_utc = parse_string_arg(args, 3, "now_utc")?;

        let cron = CronSchedule::new(&expression, &timezone).map_err(failure)?;
        let now_dt = parse_iso_date(&now_utc)
            .ok_or_else(|| failure(format!("Invalid now_utc timestamp: {now_utc}")))?;

        let last_run_dt = match last_run {
            Some(ref s) if !s.trim().is_empty() => parse_iso_date(s)
                .ok_or_else(|| failure(format!("Invalid last_run timestamp: {s}")))?,
            _ => now_dt,
        };

        let overdue = cron.find_overdue_runs(last_run_dt, now_dt);
        let list: Vec<Value> = overdue
            .into_iter()
            .map(|dt| Value::String(dt.to_rfc3339_opts(SecondsFormat::Millis, true)))
            .collect();
        Ok(Value::Array(list))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HostConfig, HostContext};
    use praxis_contracts::RustRpcRequest;
    use praxis_workflows::types::WorkflowDefinition;
    use serde_json::json;

    fn test_host() -> HostContext {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = format!("/tmp/praxis-workflow-test-{}-{nanos}", std::process::id());
        let settings = format!("{dir}/test-settings.json");
        let config = HostConfig::new(&dir, &settings, true, true).expect("config");
        let host = HostContext::new(config);
        register_workflow_channels(&host);
        host
    }

    fn rpc(host: &HostContext, channel: &str, args: Vec<Value>) -> Value {
        let resp = host.dispatch_rpc(RustRpcRequest {
            id: "test-req".to_string(),
            channel: channel.to_string(),
            args,
        });
        assert!(resp.ok, "RPC {channel} failed: {:?}", resp.error);
        resp.result.unwrap_or(Value::Null)
    }

    fn sample_definition() -> WorkflowDefinition {
        let val = json!({
            "schemaVersion": 1,
            "id": "wf-test",
            "name": "Test Workflow",
            "scope": "project",
            "projectId": "p1",
            "version": 1,
            "entryNodeId": "approval-1",
            "createdAt": "2026-11-09T00:00:00.000Z",
            "updatedAt": "2026-11-09T00:00:00.000Z",
            "nodes": [
                {
                    "type": "approval",
                    "id": "approval-1",
                    "name": "Approval Stage",
                    "x": 0,
                    "y": 0,
                    "inputs": [],
                    "prompt": "Approve?",
                    "requiredGates": ["review"],
                    "allowBypass": true
                }
            ],
            "edges": []
        });
        serde_json::from_value(val).expect("valid workflow definition")
    }

    #[test]
    fn test_create_run_and_status_derivation() {
        let host = test_host();
        let def = sample_definition();
        let create_input = json!({
            "runId": "run-100",
            "projectId": "proj-1",
            "definition": def,
            "at": "2026-11-09T10:00:00.000Z"
        });

        let run_val = rpc(&host, "workflows:createRun", vec![create_input]);
        assert_eq!(run_val["runId"], "run-100");
        assert_eq!(run_val["status"], "running");

        let status_val = rpc(&host, "workflows:deriveStatus", vec![run_val.clone()]);
        assert_eq!(status_val, "awaiting-approval");

        let schedule_val = rpc(&host, "workflows:schedule", vec![run_val.clone()]);
        assert_eq!(schedule_val["awaitingApproval"], json!(["approval-1"]));
    }

    #[test]
    fn test_apply_command_and_can_retry() {
        let host = test_host();
        let def_val = json!({
            "schemaVersion": 1,
            "id": "wf-task-test",
            "name": "Task Workflow",
            "scope": "project",
            "projectId": "p1",
            "version": 1,
            "entryNodeId": "task-1",
            "createdAt": "2026-11-09T00:00:00.000Z",
            "updatedAt": "2026-11-09T00:00:00.000Z",
            "nodes": [
                {
                    "type": "agent-task",
                    "id": "task-1",
                    "name": "Task 1",
                    "x": 0,
                    "y": 0,
                    "inputs": [],
                    "agent": { "agentId": "coder", "scope": "global", "toolMode": "full" },
                    "instructions": "Do work.",
                    "outputs": [],
                    "mutatesWorktree": true,
                    "maxAttempts": 2
                }
            ],
            "edges": []
        });
        let def: WorkflowDefinition = serde_json::from_value(def_val).expect("valid def");
        let create_input = json!({
            "runId": "run-200",
            "projectId": "proj-1",
            "definition": def,
            "at": "2026-11-09T10:00:00.000Z"
        });
        let run_val = rpc(&host, "workflows:createRun", vec![create_input]);

        let retryable = rpc(
            &host,
            "workflows:canRetry",
            vec![run_val.clone(), json!("task-1")],
        );
        assert_eq!(retryable, json!(false));

        let start_cmd = json!({
            "kind": "node-started",
            "nodeId": "task-1",
            "at": "2026-11-09T10:04:00.000Z"
        });
        let running_run = rpc(&host, "workflows:applyCommand", vec![run_val, start_cmd]);

        let fail_cmd = json!({
            "kind": "node-failed",
            "nodeId": "task-1",
            "at": "2026-11-09T10:05:00.000Z",
            "error": "Failed check"
        });
        let updated = rpc(&host, "workflows:applyCommand", vec![running_run, fail_cmd]);
        assert_eq!(updated["nodes"]["task-1"]["outcome"], json!("failed"));

        let retryable_after = rpc(&host, "workflows:canRetry", vec![updated, json!("task-1")]);
        assert_eq!(retryable_after, json!(true));
    }

    #[test]
    fn test_advance_joins() {
        let host = test_host();
        let def = sample_definition();
        let create_input = json!({
            "runId": "run-300",
            "projectId": "proj-1",
            "definition": def,
            "at": "2026-11-09T10:00:00.000Z"
        });
        let run_val = rpc(&host, "workflows:createRun", vec![create_input]);
        let advanced = rpc(
            &host,
            "workflows:advanceJoins",
            vec![run_val, json!("2026-11-09T10:10:00.000Z")],
        );
        assert_eq!(advanced["runId"], "run-300");
    }

    #[test]
    fn test_approve_reject_and_bypass_gates() {
        let host = test_host();
        let def = sample_definition();
        let create_input = json!({
            "runId": "run-400",
            "projectId": "proj-1",
            "definition": def,
            "at": "2026-11-09T10:00:00.000Z"
        });
        let run_val = rpc(&host, "workflows:createRun", vec![create_input]);

        let policy = json!({
            "schemaVersion": 1,
            "id": "policy-1",
            "name": "Permissive Policy",
            "scope": "project",
            "requiredGates": [],
            "requireHumanApproval": true,
            "allowGateBypass": true,
            "requireTrustedAgents": false,
            "maxAttemptsPerNode": 1,
            "createdAt": "2026-11-09T00:00:00.000Z",
            "updatedAt": "2026-11-09T00:00:00.000Z"
        });

        // Evaluate gates initially
        let eval = rpc(
            &host,
            "workflows:evaluateGates",
            vec![run_val.clone(), json!("approval-1"), Value::Null, json!([])],
        );
        assert_eq!(eval["gates"].as_array().expect("gates array").len(), 1);
        assert_eq!(eval["gates"][0]["gate"], "review");

        // Attempt approve without meeting review gate -> refused
        let approve_res = rpc(
            &host,
            "workflows:approveStage",
            vec![
                run_val.clone(),
                json!("approval-1"),
                json!({ "actor": "tester", "at": "2026-11-09T10:02:00.000Z" }),
            ],
        );
        assert_eq!(approve_res["ok"], json!(false));
        assert!(
            approve_res["reason"]
                .as_str()
                .expect("reason string")
                .contains("blocked")
        );

        // Bypass the review gate (using policy allowing bypass)
        let bypass_res = rpc(
            &host,
            "workflows:bypassGate",
            vec![
                run_val.clone(),
                json!("approval-1"),
                json!("review"),
                json!("security-lead"),
                json!("Urgent hotfix"),
                json!("2026-11-09T10:03:00.000Z"),
                policy.clone(),
            ],
        );
        assert_eq!(bypass_res["ok"], json!(true));
        let bypassed_run = bypass_res["run"].clone();

        // Now approval should succeed
        let approve_res2 = rpc(
            &host,
            "workflows:approveStage",
            vec![
                bypassed_run,
                json!("approval-1"),
                json!({ "actor": "release-mgr", "at": "2026-11-09T10:05:00.000Z" }),
                policy,
            ],
        );
        assert_eq!(approve_res2["ok"], json!(true));

        // Test rejection on fresh run
        let run_val2 = rpc(
            &host,
            "workflows:createRun",
            vec![json!({
                "runId": "run-401",
                "projectId": "proj-1",
                "definition": sample_definition(),
                "at": "2026-11-09T10:00:00.000Z"
            })],
        );
        let reject_res = rpc(
            &host,
            "workflows:rejectStage",
            vec![
                run_val2,
                json!("approval-1"),
                json!({ "actor": "qa-lead", "reason": "Defects present" }),
            ],
        );
        assert_eq!(reject_res["ok"], json!(true));
        assert_eq!(
            reject_res["run"]["nodes"]["approval-1"]["outcome"],
            json!("failed")
        );
    }

    #[test]
    fn test_rework() {
        let host = test_host();
        let def = sample_definition();
        let create_input = json!({
            "runId": "run-500",
            "projectId": "proj-1",
            "definition": def,
            "at": "2026-11-09T10:00:00.000Z"
        });
        let run_val = rpc(&host, "workflows:createRun", vec![create_input]);

        let reworked = rpc(
            &host,
            "workflows:rework",
            vec![
                run_val,
                json!("approval-1"),
                json!("2026-11-09T10:15:00.000Z"),
                json!("Manual review request"),
            ],
        );
        assert_eq!(reworked["runId"], "run-500");
    }

    #[test]
    fn test_cron_next_and_overdue() {
        let host = test_host();

        let next_val = rpc(
            &host,
            "workflows:cronNext",
            vec![
                json!("0 12 * * *"),
                json!("UTC"),
                json!("2026-11-09T08:00:00.000Z"),
            ],
        );
        assert_eq!(next_val, json!("2026-11-09T12:00:00.000Z"));

        let overdue_val = rpc(
            &host,
            "workflows:cronOverdue",
            vec![
                json!("0 * * * *"),
                json!("UTC"),
                json!("2026-11-09T08:00:00.000Z"),
                json!("2026-11-09T11:30:00.000Z"),
            ],
        );
        let overdue_arr = overdue_val.as_array().expect("overdue array");
        assert_eq!(overdue_arr.len(), 3);
        assert_eq!(overdue_arr[0], json!("2026-11-09T09:00:00.000Z"));
        assert_eq!(overdue_arr[1], json!("2026-11-09T10:00:00.000Z"));
        assert_eq!(overdue_arr[2], json!("2026-11-09T11:00:00.000Z"));
    }
}
