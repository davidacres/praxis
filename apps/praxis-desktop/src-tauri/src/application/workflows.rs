//! Workflows and policy orchestration in-process service.

use std::fs;
use std::path::PathBuf;

use chrono::{SecondsFormat, Utc};
use praxis_host::HostContext;
use praxis_workflows::validation::validate_workflow;
use praxis_workflows::gates::{GateBypassInput, approve_stage, bypass_gate};
use praxis_workflows::run::{
    CreateWorkflowRunInput, DeclaredArtifact, LoopDecisionKind, ReworkOptions, WorkflowRun,
    WorkflowRunCommand, apply_workflow_run_command, create_workflow_run, rework_workflow_run,
};
use praxis_workflows::scheduler::{advance_joins, derive_run_status};
use praxis_workflows::types::{
    WorkflowDefinition, WorkflowGateKind, WorkflowNode, WorkflowNodeOutcome, WorkflowPolicyProfile,
    WorkflowScope,
};
use serde_json::{Value, json};

use super::storage;
use super::{Result, failure, text};

pub const WORKFLOW_RUNS_KEY: &str = "praxis.workflowRuns.v1";
pub const WORKFLOW_POLICIES_KEY: &str = "praxis.workflowPolicies.v1";

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn workflows_path(host: &HostContext) -> PathBuf {
    host.config().user_data_dir.join("workflows.json")
}

fn read_workflows_json(host: &HostContext) -> Value {
    let path = workflows_path(host);
    fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_workflows_json(host: &HostContext, root: &Value) -> Result<()> {
    let path = workflows_path(host);
    let serialized = serde_json::to_string_pretty(root).map_err(failure)?;
    storage::write_atomic(&path, &format!("{serialized}\n"), false)
}

fn get_runs(host: &HostContext) -> Vec<WorkflowRun> {
    let root = read_workflows_json(host);
    root.get(WORKFLOW_RUNS_KEY)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|val| serde_json::from_value(val.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn save_runs(host: &HostContext, runs: &[WorkflowRun]) -> Result<()> {
    let mut root = read_workflows_json(host);
    if !root.is_object() {
        root = json!({});
    }
    root[WORKFLOW_RUNS_KEY] = serde_json::to_value(runs).map_err(failure)?;
    write_workflows_json(host, &root)
}

fn save_single_run(host: &HostContext, run: WorkflowRun) -> Result<WorkflowRun> {
    let mut runs = get_runs(host);
    if let Some(idx) = runs.iter().position(|r| r.run_id == run.run_id) {
        runs[idx] = run.clone();
    } else {
        runs.push(run.clone());
    }
    save_runs(host, &runs)?;
    host.events()
        .emit("workflows:runChanged", Some(json!(run.run_id)));
    Ok(run)
}

fn summarize_loops(run: &WorkflowRun) -> Vec<Value> {
    use praxis_workflows::edges::{
        PendingLoopKind, describe_findings_predicate, loop_statuses, pending_loop,
    };
    use praxis_workflows::types::WorkflowEdgeOutcome;
    let pending = pending_loop(run);
    let name = |id: &str| {
        run.definition
            .nodes
            .iter()
            .find(|node| node.base().id == id)
            .map(|node| node.base().name.clone())
            .unwrap_or_else(|| id.to_string())
    };
    loop_statuses(run)
        .into_iter()
        .map(|status| {
            let edge = &status.edge;
            let needs_decision = pending.as_ref().is_some_and(|(kind, pending)| {
                matches!(kind, PendingLoopKind::Decide) && pending.edge.id == edge.id
            });
            let history: Vec<Value> = run
                .loop_history
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|entry| entry.edge_id == edge.id)
                .map(|entry| {
                    let mut row = serde_json::to_value(entry).expect("serializable loop history");
                    row["topFindings"] = json!(entry.findings);
                    row
                })
                .collect();
            let decisions: Vec<_> = run
                .loop_decisions
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|decision| decision.edge_id == edge.id)
                .collect();
            let condition = match edge.on {
                WorkflowEdgeOutcome::Findings => {
                    describe_findings_predicate(edge.when.as_ref(), run.parameters.as_ref())
                }
                WorkflowEdgeOutcome::Failure => "the stage fails".into(),
                WorkflowEdgeOutcome::Always => "every time".into(),
                WorkflowEdgeOutcome::Success => "the stage succeeds".into(),
            };
            json!({
                "edgeId": edge.id, "fromNodeId": edge.from, "fromName": name(&edge.from),
                "toNodeId": edge.to, "toName": name(&edge.to), "on": edge.on,
                "condition": condition, "iterationsTaken": status.iterations_taken,
                "budget": status.budget, "firing": status.fires && !status.exhausted,
                "needsDecision": needs_decision, "history": history, "decisions": decisions,
            })
        })
        .collect()
}

pub fn summarize_run(run: &WorkflowRun) -> Value {
    let status = derive_run_status(run);
    let mut stages = Vec::new();
    for node in &run.definition.nodes {
        let base = node.base();
        let state = run.nodes.get(&base.id);
        let attempts = state.map(|s| s.attempts.len()).unwrap_or(0);
        let lane = if let Some(s) = state {
            match s.outcome {
                WorkflowNodeOutcome::Running => "running",
                WorkflowNodeOutcome::Succeeded => "succeeded",
                WorkflowNodeOutcome::Failed => "failed",
                _ => "pending",
            }
        } else {
            "pending"
        };
        stages.push(json!({
            "nodeId": base.id,
            "name": base.name,
            "type": match node {
                WorkflowNode::AgentTask(_) => "agent-task",
                WorkflowNode::Check(_) => "check",
                WorkflowNode::Deployment(_) => "deployment",
                WorkflowNode::Approval(_) => "approval",
                WorkflowNode::Join(_) => "join",
                WorkflowNode::Merge(_) => "merge",
                WorkflowNode::Map(_) => "map",
            },
            "lane": lane,
            "attempts": attempts,
            "artifacts": state.map(|s| &s.artifacts).unwrap_or(&vec![]),
        }));
    }

    let graph = json!({
        "nodes": run.definition.nodes.iter().map(|n| {
            let base = n.base();
            json!({
                "id": base.id,
                "x": base.x,
                "y": base.y,
                "type": match n {
                    WorkflowNode::AgentTask(_) => "agent-task",
                    WorkflowNode::Check(_) => "check",
                    WorkflowNode::Deployment(_) => "deployment",
                    WorkflowNode::Approval(_) => "approval",
                    WorkflowNode::Join(_) => "join",
                    WorkflowNode::Merge(_) => "merge",
                    WorkflowNode::Map(_) => "map",
                }
            })
        }).collect::<Vec<_>>(),
        "edges": run.definition.edges,
        "entryNodeId": run.definition.entry_node_id,
    });

    let mut summary = json!({
        "runId": run.run_id,
        "projectId": run.project_id,
        "workflowId": run.workflow_id,
        "workflowName": run.display_name.clone().unwrap_or_else(|| run.definition.name.clone()),
        "status": status,
        "explanation": format!("Run is {:?}", status),
        "stages": stages,
        "graph": graph,
        "gates": run.gate_decisions,
        "branchGroups": [],
        "loops": summarize_loops(run),
        "actions": [],
        "events": run.events,
        "startedAt": run.started_at,
        "permissionMode": "ask",
    });

    if let Some(ended_at) = &run.ended_at {
        summary["endedAt"] = json!(ended_at);
    }
    if let Some(display_name) = &run.display_name {
        summary["displayName"] = json!(display_name);
    }
    if let Some(key) = &run.controller_session_key {
        summary["controllerSessionKey"] = json!(key);
    }
    if let Some(id) = &run.controller_session_id {
        summary["controllerSessionId"] = json!(id);
    }
    if let Some(plan) = &run.plan_input {
        summary["planInput"] = json!(plan);
    }
    if let Some(archived) = run.archived
        && archived
    {
        summary["archived"] = json!(true);
        summary["archivedAt"] = json!(run.archived_at);
    }
    summary
}

fn embedded_templates() -> Value {
    serde_json::from_str(include_str!("../../workflow-templates.json"))
        .unwrap_or_else(|_| json!({ "builtIn": [], "marketplace": [] }))
}

// ── Project & Template definitions ──────────────────────────────────────

fn project_workflows_key(project_id: &str) -> String {
    format!("praxis.projectWorkflows.{project_id}")
}

fn get_project_definitions(host: &HostContext, project_id: &str) -> Vec<WorkflowDefinition> {
    let root = read_workflows_json(host);
    let key = project_workflows_key(project_id);
    root.get(&key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|val| serde_json::from_value(val.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn save_project_definition(
    host: &HostContext,
    project_id: &str,
    definition: WorkflowDefinition,
) -> Result<()> {
    let mut root = read_workflows_json(host);
    if !root.is_object() {
        root = json!({});
    }
    let key = project_workflows_key(project_id);
    let mut defs = get_project_definitions(host, project_id);
    if let Some(idx) = defs.iter().position(|d| d.id == definition.id) {
        defs[idx] = definition;
    } else {
        defs.push(definition);
    }
    root[&key] = serde_json::to_value(&defs).map_err(failure)?;
    write_workflows_json(host, &root)
}

fn remove_project_definition(
    host: &HostContext,
    project_id: &str,
    workflow_id: &str,
) -> Result<()> {
    let mut root = read_workflows_json(host);
    if !root.is_object() {
        root = json!({});
    }
    let key = project_workflows_key(project_id);
    let defs = get_project_definitions(host, project_id);
    let next: Vec<_> = defs.into_iter().filter(|d| d.id != workflow_id).collect();
    root[&key] = serde_json::to_value(&next).map_err(failure)?;
    write_workflows_json(host, &root)
}

// ── Channel Handlers ────────────────────────────────────────────────────

pub fn project_trust(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let workflow_id = text(args, 1)?;
    let root = read_workflows_json(host);
    let key = format!("praxis.workflowTrust.{project_id}.{workflow_id}");
    let stored_fingerprint = root.get(&key).and_then(Value::as_str);
    Ok(json!({
        "key": key,
        "trusted": stored_fingerprint.is_some(),
        "fingerprint": stored_fingerprint
    }))
}

pub fn approve_project_trust(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let workflow_id = text(args, 1)?;
    let fingerprint = text(args, 2)?;
    let mut root = read_workflows_json(host);
    if !root.is_object() {
        root = json!({});
    }
    let key = format!("praxis.workflowTrust.{project_id}.{workflow_id}");
    root[&key] = json!(fingerprint);
    write_workflows_json(host, &root)?;
    Ok(Value::Null)
}

pub fn list_templates(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let embedded = embedded_templates();
    let mut list = Vec::new();
    if let Some(built_ins) = embedded.get("builtIn").and_then(Value::as_array) {
        for t in built_ins {
            list.push(json!({
                "definition": t,
                "source": "built-in"
            }));
        }
    }
    for def in get_project_definitions(host, project_id) {
        list.push(json!({
            "definition": def,
            "source": "project"
        }));
    }
    Ok(json!(list))
}

pub fn get_recommended_template(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(Value::Null)
}

pub fn recommend_template(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(json!({
        "templateId": "governed-delivery",
        "rationale": "Governed delivery ensures code quality, linting, and automated checks.",
        "model": "recommended",
        "provider": "anthropic"
    }))
}

pub fn recommend_model_tiers(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(json!({
        "tiers": {},
        "provider": "anthropic",
        "model": "claude-3-5-sonnet"
    }))
}

pub fn template_readiness(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let embedded = embedded_templates();
    let mut list = Vec::new();
    if let Some(built_ins) = embedded.get("builtIn").and_then(Value::as_array) {
        for t in built_ins {
            list.push(json!({
                "templateId": t.get("id"),
                "ready": false,
                "structureOk": false,
                "agentsOk": false,
                "dependencies": [],
                "autoInstallable": false,
                "blockingByNode": {"runtime": "Live workflow readiness has not been verified in this Tauri build."},
                "missingTools": [],
                "missingAgents": []
            }));
        }
    }
    for def in get_project_definitions(host, project_id) {
        list.push(json!({
            "templateId": def.id,
            "ready": false,
            "structureOk": false,
            "agentsOk": false,
            "dependencies": [],
            "autoInstallable": false,
            "blockingByNode": {"runtime": "Live workflow readiness has not been verified in this Tauri build."},
            "missingTools": [],
            "missingAgents": []
        }));
    }
    Ok(json!(list))
}

pub fn catalog(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let embedded = embedded_templates();
    let built_in = embedded
        .get("builtIn")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let marketplace = embedded
        .get("marketplace")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let project_defs: Vec<_> = get_project_definitions(host, project_id)
        .into_iter()
        .map(|d| json!({ "definition": d, "source": "project" }))
        .collect();

    Ok(json!({
        "builtIn": built_in,
        "marketplace": marketplace,
        "global": [],
        "project": project_defs
    }))
}

pub fn get(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let workflow_id = text(args, 1)?;
    let defs = get_project_definitions(host, project_id);
    let found = defs.into_iter().find(|d| d.id == workflow_id);
    if let Some(found) = found {
        return serde_json::to_value(found).map_err(failure);
    }
    let embedded = embedded_templates();
    if let Some(built_ins) = embedded.get("builtIn").and_then(Value::as_array)
        && let Some(t) = built_ins
            .iter()
            .find(|b| b.get("id").and_then(Value::as_str) == Some(workflow_id))
    {
        return Ok(t.clone());
    }
    Ok(Value::Null)
}

pub fn instantiate(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let template_id = text(args, 1)?;
    let name_override = args.get(2).and_then(Value::as_str);

    let embedded = embedded_templates();
    let built_ins = embedded.get("builtIn").and_then(Value::as_array);
    let marketplace = embedded.get("marketplace").and_then(Value::as_array);

    let template_val = built_ins
        .into_iter()
        .flatten()
        .chain(marketplace.into_iter().flatten())
        .find(|t| t.get("id").and_then(Value::as_str) == Some(template_id))
        .ok_or_else(|| failure(format!("Template {template_id} not found")))?;

    let mut def: WorkflowDefinition =
        serde_json::from_value(template_val.clone()).map_err(failure)?;
    def.id = uuid::Uuid::new_v4().to_string();
    def.scope = WorkflowScope::Project;
    def.project_id = Some(project_id.to_string());
    if let Some(name) = name_override {
        def.name = name.to_string();
    }
    let current_now = now();
    def.created_at = current_now.clone();
    def.updated_at = current_now;

    save_project_definition(host, project_id, def.clone())?;
    serde_json::to_value(def).map_err(failure)
}

pub fn promote_pack(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let pack_id = text(args, 1)?;
    let current_now = now();

    let def = WorkflowDefinition {
        schema_version: 1,
        id: pack_id.to_string(),
        name: format!("Promoted {pack_id}"),
        description: Some("Promoted workflow pack".into()),
        trigger: None,
        scope: WorkflowScope::Project,
        project_id: Some(project_id.to_string()),
        version: 1,
        entry_node_id: "start".into(),
        built_in: Some(false),
        parameters: None,
        requires_measurable_goal: None,
        created_at: current_now.clone(),
        updated_at: current_now,
        nodes: Vec::new(),
        edges: Vec::new(),
    };

    save_project_definition(host, project_id, def.clone())?;
    serde_json::to_value(def).map_err(failure)
}

pub fn save(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let val = args.get(1).ok_or_else(|| failure("definition required"))?;
    if val.get("scope").and_then(Value::as_str) != Some("project")
        || val.get("projectId").and_then(Value::as_str) != Some(project_id)
    {
        return Err(failure(
            "The designer can only save a project-scoped workflow for its own project.",
        ));
    }
    let result = validate_workflow(val, None);
    if !result.valid() {
        let detail: Vec<String> = result
            .errors
            .iter()
            .map(|issue| format!("{}: {}", issue.path, issue.message))
            .collect();
        return Err(failure(format!("Workflow is invalid: {}", detail.join("; "))));
    }
    let mut def: WorkflowDefinition = serde_json::from_value(val.clone()).map_err(failure)?;
    def.project_id = Some(project_id.to_string());
    def.updated_at = now();
    save_project_definition(host, project_id, def.clone())?;
    serde_json::to_value(def).map_err(failure)
}

pub fn remove(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let workflow_id = text(args, 1)?;
    remove_project_definition(host, project_id, workflow_id)?;
    Ok(Value::Null)
}

fn policy_value_for(host: &HostContext, project_id: &str) -> Option<Value> {
    effective_policy(host, &[json!(project_id)])
        .ok()
        .filter(|v| !v.is_null())
}

pub fn validate(host: &HostContext, args: &[Value]) -> Result<Value> {
    let definition = args
        .get(1)
        .or_else(|| args.first())
        .ok_or_else(|| failure("definition required"))?;
    let project_id = args
        .first()
        .and_then(Value::as_str)
        .or_else(|| definition.get("projectId").and_then(Value::as_str));
    let policy = project_id.and_then(|id| policy_value_for(host, id));
    Ok(validate_workflow(definition, policy.as_ref()).to_json())
}

pub fn assistant(_host: &HostContext, args: &[Value]) -> Result<Value> {
    let message = text(args, 2)?;
    Ok(json!({
        "action": "answer",
        "message": format!("Received workflow inquiry: {message}"),
        "workflow": null
    }))
}

pub fn effective_policy(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let root = read_workflows_json(host);
    let policies = root
        .get(WORKFLOW_POLICIES_KEY)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|val| serde_json::from_value::<WorkflowPolicyProfile>(val.clone()).ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let project_policy = policies
        .iter()
        .find(|p| p.scope == WorkflowScope::Project && p.project_id.as_deref() == Some(project_id));
    let global_policy = policies.iter().find(|p| p.scope == WorkflowScope::Global);

    let effective = project_policy.or(global_policy);
    Ok(json!(effective))
}

pub fn list_policies(host: &HostContext) -> Result<Value> {
    let root = read_workflows_json(host);
    let policies = root
        .get(WORKFLOW_POLICIES_KEY)
        .cloned()
        .unwrap_or_else(|| json!([]));
    Ok(policies)
}

pub fn save_policy(host: &HostContext, args: &[Value]) -> Result<Value> {
    let val = args
        .first()
        .ok_or_else(|| failure("policy profile required"))?;
    let mut profile: WorkflowPolicyProfile =
        serde_json::from_value(val.clone()).map_err(failure)?;
    let current_now = now();
    profile.updated_at = current_now;

    let mut root = read_workflows_json(host);
    if !root.is_object() {
        root = json!({});
    }
    let mut policies: Vec<WorkflowPolicyProfile> = root
        .get(WORKFLOW_POLICIES_KEY)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    if let Some(idx) = policies.iter().position(|p| p.id == profile.id) {
        policies[idx] = profile.clone();
    } else {
        policies.push(profile.clone());
    }
    root[WORKFLOW_POLICIES_KEY] = serde_json::to_value(&policies).map_err(failure)?;
    write_workflows_json(host, &root)?;
    serde_json::to_value(profile).map_err(failure)
}

pub fn remove_policy(host: &HostContext, args: &[Value]) -> Result<Value> {
    let profile_id = text(args, 0)?;
    let mut root = read_workflows_json(host);
    if !root.is_object() {
        root = json!({});
    }
    let policies: Vec<WorkflowPolicyProfile> = root
        .get(WORKFLOW_POLICIES_KEY)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    let next: Vec<_> = policies
        .into_iter()
        .filter(|p| p.id != profile_id)
        .collect();
    root[WORKFLOW_POLICIES_KEY] = serde_json::to_value(&next).map_err(failure)?;
    write_workflows_json(host, &root)?;
    Ok(Value::Null)
}

pub fn start_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let workflow_id = text(args, 1)?;
    let _task_title = args
        .get(2)
        .and_then(Value::as_str)
        .unwrap_or("Workflow task");

    let defs = get_project_definitions(host, project_id);
    let mut definition = defs.into_iter().find(|d| d.id == workflow_id);
    if definition.is_none() {
        let embedded = embedded_templates();
        if let Some(built_ins) = embedded.get("builtIn").and_then(Value::as_array) {
            definition = built_ins
                .iter()
                .find(|b| b.get("id").and_then(Value::as_str) == Some(workflow_id))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
        }
    }
    let definition =
        definition.ok_or_else(|| failure(format!("Workflow {workflow_id} not found")))?;

    let input = CreateWorkflowRunInput {
        run_id: uuid::Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        definition,
        at: now(),
        issue_key: None,
        issue_connection_id: None,
        scheduled_launch_token: None,
        shared_delivery_branch: None,
        defer_merge: false,
        controller_session_key: None,
        controller_session_id: None,
        plan_input: None,
        permission_mode: None,
        uncommitted_changes: None,
        ai_provider: None,
        ai_model: None,
        provider_limit_policy: None,
        parameters: None,
    };

    let run = create_workflow_run(input);
    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn prepare_run(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(json!({
        "readiness": "ready",
        "parameters": {}
    }))
}

pub fn check_run_base(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(json!({
        "blockingFiles": []
    }))
}

pub fn commit_run_base(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(Value::Null)
}

pub fn select_controller_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let _session_key = text(args, 0)?;
    let run_id = text(args, 1)?;
    let runs = get_runs(host);
    let run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;
    Ok(summarize_run(&run))
}

pub fn remove_controller_run(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(Value::Null)
}

pub fn list_runs(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let runs = get_runs(host);
    let summaries: Vec<Value> = runs
        .into_iter()
        .filter(|r| r.project_id == project_id)
        .map(|r| summarize_run(&r))
        .collect();
    Ok(json!(summaries))
}

pub fn get_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let runs = get_runs(host);
    let found = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .map(|r| summarize_run(&r));
    Ok(json!(found))
}

pub fn rename_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let name = text(args, 1)?;
    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;
    run.display_name = Some(name.to_string());
    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn advance_stage(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?;
    let outcome = text(args, 2)?;
    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    let current_now = now();
    let start_cmd = WorkflowRunCommand::NodeStarted {
        node_id: node_id.to_string(),
        at: current_now.clone(),
        session_id: Some(format!("stage-{node_id}")),
    };
    run = apply_workflow_run_command(&run, &start_cmd).unwrap_or(run);

    let artifacts: Vec<DeclaredArtifact> = if outcome == "succeeded" {
        run.definition
            .nodes
            .iter()
            .find(|n| n.base().id == node_id)
            .map(|n| match n {
                WorkflowNode::AgentTask(task) => task
                    .outputs
                    .iter()
                    .map(|out| DeclaredArtifact {
                        contract_id: out.id.clone(),
                        kind: out.kind,
                        path: None,
                        artifact_id: None,
                        reference: None,
                    })
                    .collect(),
                _ => Vec::new(),
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let end_cmd = match outcome {
        "succeeded" => WorkflowRunCommand::NodeSucceeded {
            node_id: node_id.to_string(),
            at: current_now.clone(),
            artifacts: Some(artifacts),
            exit_code: Some(0),
            snapshot_ref: None,
            assessed_snapshot_ref: None,
            findings: None,
            provider: None,
            model: None,
            independence: None,
            map_items: None,
        },
        _ => WorkflowRunCommand::NodeFailed {
            node_id: node_id.to_string(),
            at: current_now.clone(),
            error: "Stage failed".into(),
            exit_code: Some(1),
            findings: None,
            pause: None,
            provider: None,
            model: None,
            independence: None,
            map_items: None,
            conflict_files: None,
        },
    };
    run = apply_workflow_run_command(&run, &end_cmd).unwrap_or(run);
    run = advance_joins(run, &current_now);

    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn approve_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let actor = text(args, 1)?;
    let node_id = args.get(3).and_then(Value::as_str);

    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    let current_now = now();
    let target_node_id = node_id
        .map(str::to_string)
        .or_else(|| {
            run.definition
                .nodes
                .iter()
                .find(|n| matches!(n, WorkflowNode::Approval(_)))
                .map(|n| n.base().id.clone())
        })
        .ok_or_else(|| failure("No approval node found in run"))?;

    let res = approve_stage(&run, &target_node_id, actor, &current_now, None, None)
        .map_err(|e| failure(e.to_string()))?;
    run = advance_joins(res.run, &current_now);

    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn bypass_gate_cmd(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let gate_str = text(args, 1)?;
    let actor = text(args, 2)?;
    let reason = text(args, 3)?;
    let node_id = args.get(4).and_then(Value::as_str);

    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    let current_now = now();
    let target_node_id = node_id
        .map(str::to_string)
        .or_else(|| {
            run.definition
                .nodes
                .iter()
                .find(|n| matches!(n, WorkflowNode::Approval(_)))
                .map(|n| n.base().id.clone())
        })
        .ok_or_else(|| failure("No approval node found in run"))?;

    let gate = match gate_str {
        "security" => WorkflowGateKind::Security,
        "qa" => WorkflowGateKind::Qa,
        _ => WorkflowGateKind::Review,
    };

    let bypass_input = GateBypassInput {
        gate,
        actor: actor.to_string(),
        reason: reason.to_string(),
        at: current_now.clone(),
    };

    let res = bypass_gate(&run, &target_node_id, &bypass_input, None, None)
        .map_err(|e| failure(e.to_string()))?;
    run = advance_joins(res.run, &current_now);

    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn skip_approval(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?;
    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    let current_now = now();
    let skip_cmd = WorkflowRunCommand::NodeSkipped {
        node_id: node_id.to_string(),
        at: current_now.clone(),
        reason: "Approval skipped by user".into(),
    };
    run = apply_workflow_run_command(&run, &skip_cmd).unwrap_or(run);
    run = advance_joins(run, &current_now);

    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn decide_loop(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let edge_id = text(args, 1)?;
    let actor = text(args, 2)?;
    let decision_str = text(args, 3)?;
    let reason = args.get(4).and_then(Value::as_str);
    let extra_iterations = args.get(5).and_then(Value::as_u64).map(|n| n as u32);

    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    let decision = match decision_str {
        "accept" => LoopDecisionKind::Accept,
        "grant" => LoopDecisionKind::Grant,
        "stop" => LoopDecisionKind::Stop,
        _ => return Err(failure("Invalid decision: must be accept, grant or stop")),
    };

    let current_now = now();
    let cmd = WorkflowRunCommand::LoopDecided {
        edge_id: edge_id.to_string(),
        at: current_now.clone(),
        actor: actor.to_string(),
        decision,
        reason: reason.map(str::to_string),
        extra_iterations: extra_iterations.map(|n| n as f64),
    };
    run = apply_workflow_run_command(&run, &cmd).unwrap_or(run);
    run = advance_joins(run, &current_now);

    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn stage_report(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(Value::Null)
}

pub fn save_stage_report(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(json!({ "saved": false }))
}

pub fn retry_stage(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?;
    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    let current_now = now();
    let cmd = WorkflowRunCommand::NodeRetry {
        node_id: node_id.to_string(),
        at: current_now,
    };
    run = apply_workflow_run_command(&run, &cmd).unwrap_or(run);
    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn switch_stage_provider(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?;
    let provider = text(args, 2)?;
    let model = args.get(3).and_then(Value::as_str).map(str::to_string);

    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    let current_now = now();
    let cmd = WorkflowRunCommand::StageProviderSwitched {
        node_id: node_id.to_string(),
        at: current_now,
        provider: provider.to_string(),
        model,
        automatic: Some(false),
    };
    run = apply_workflow_run_command(&run, &cmd).unwrap_or(run);
    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn stop_for_provider_limit(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?;
    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    let current_now = now();
    let cmd = WorkflowRunCommand::ProviderLimitStop {
        node_id: node_id.to_string(),
        at: current_now,
        detail: Some("Provider limit reached".into()),
    };
    run = apply_workflow_run_command(&run, &cmd).unwrap_or(run);
    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn rework_stage(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?;
    let runs = get_runs(host);
    let run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    let current_now = now();
    let options = ReworkOptions {
        by_person: true,
        ..Default::default()
    };
    let res = rework_workflow_run(&run, node_id, &current_now, &options);
    if let Some(err) = res.reason {
        return Err(failure(err));
    }
    let saved = save_single_run(host, res.run)?;
    Ok(summarize_run(&saved))
}

pub fn resolve_merge_with_ai(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let runs = get_runs(host);
    let run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;
    Ok(summarize_run(&run))
}

pub fn cancel_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let reason = args.get(1).and_then(Value::as_str);
    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    let current_now = now();
    let cmd = WorkflowRunCommand::Cancel {
        at: current_now,
        reason: reason.map(str::to_string),
    };
    run = apply_workflow_run_command(&run, &cmd).unwrap_or(run);
    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn inspect_run_work(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(json!({
        "commitCount": 0,
        "commits": [],
        "uncommittedFiles": 0,
        "hasWork": false
    }))
}

pub fn delete_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let runs = get_runs(host);
    let next: Vec<_> = runs.into_iter().filter(|r| r.run_id != run_id).collect();
    save_runs(host, &next)?;
    host.events()
        .emit("workflows:runChanged", Some(json!(run_id)));
    Ok(Value::Null)
}

pub fn archive_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let archived = args
        .get(1)
        .and_then(Value::as_bool)
        .ok_or_else(|| failure("archived boolean required"))?;

    let runs = get_runs(host);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| failure(format!("Run {run_id} not found")))?;

    run.archived = Some(archived);
    run.archived_at = if archived { Some(now()) } else { None };

    let saved = save_single_run(host, run)?;
    Ok(summarize_run(&saved))
}

pub fn get_evidence(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(json!({ "expired": false }))
}

pub fn start_diagnosis(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(json!({ "sessionKey": null }))
}

pub fn get_recommendation(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(json!({ "recommendation": null, "stale": false }))
}

pub fn clear_recommendation(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(Value::Null)
}

pub fn recommend_agent(_host: &HostContext, args: &[Value]) -> Result<Value> {
    let val = args.get(2).and_then(Value::as_object);
    let candidates = val
        .and_then(|o| o.get("candidates"))
        .and_then(Value::as_array);
    let first_agent = candidates
        .and_then(|c| c.first())
        .and_then(|cand| cand.get("agentId"))
        .and_then(Value::as_str)
        .unwrap_or("general-purpose");

    Ok(json!({
        "agentId": first_agent,
        "rationale": "Selected best matching agent for stage",
        "model": "recommended",
        "provider": "anthropic"
    }))
}

pub fn dispatch(host: &HostContext, channel: &str, args: &[Value]) -> Result<Value> {
    match channel {
        "workflows:projectTrust" => project_trust(host, args),
        "workflows:approveProjectTrust" => approve_project_trust(host, args),
        "workflows:listTemplates" => list_templates(host, args),
        "workflows:getRecommendedTemplate" => get_recommended_template(host, args),
        "workflows:recommendTemplate" => recommend_template(host, args),
        "workflows:recommendModelTiers" => recommend_model_tiers(host, args),
        "workflows:templateReadiness" => template_readiness(host, args),
        "workflows:catalog" => catalog(host, args),
        "workflows:get" => get(host, args),
        "workflows:instantiate" => instantiate(host, args),
        "workflows:promotePack" => promote_pack(host, args),
        "workflows:save" => save(host, args),
        "workflows:remove" => remove(host, args),
        "workflows:validate" => validate(host, args),
        "workflows:assistant" => assistant(host, args),
        "workflows:effectivePolicy" => effective_policy(host, args),
        "workflows:listPolicies" => list_policies(host),
        "workflows:savePolicy" => save_policy(host, args),
        "workflows:removePolicy" => remove_policy(host, args),
        "workflows:startRun" => start_run(host, args),
        "workflows:prepareRun" => prepare_run(host, args),
        "workflows:checkRunBase" => check_run_base(host, args),
        "workflows:commitRunBase" => commit_run_base(host, args),
        "workflows:selectControllerRun" => select_controller_run(host, args),
        "workflows:removeControllerRun" => remove_controller_run(host, args),
        "workflows:listRuns" => list_runs(host, args),
        "workflows:getRun" => get_run(host, args),
        "workflows:renameRun" => rename_run(host, args),
        "workflows:advanceStage" => advance_stage(host, args),
        "workflows:approveRun" => approve_run(host, args),
        "workflows:bypassGate" => bypass_gate_cmd(host, args),
        "workflows:skipApproval" => skip_approval(host, args),
        "workflows:decideLoop" => decide_loop(host, args),
        "workflows:stageReport" => stage_report(host, args),
        "workflows:saveStageReport" => save_stage_report(host, args),
        "workflows:retryStage" => retry_stage(host, args),
        "workflows:switchStageProvider" => switch_stage_provider(host, args),
        "workflows:stopForProviderLimit" => stop_for_provider_limit(host, args),
        "workflows:reworkStage" => rework_stage(host, args),
        "workflows:resolveMergeWithAi" => resolve_merge_with_ai(host, args),
        "workflows:cancelRun" => cancel_run(host, args),
        "workflows:inspectRunWork" => inspect_run_work(host, args),
        "workflows:deleteRun" => delete_run(host, args),
        "workflows:archiveRun" => archive_run(host, args),
        "workflows:getEvidence" => get_evidence(host, args),
        "workflows:startDiagnosis" => start_diagnosis(host, args),
        "workflows:getRecommendation" => get_recommendation(host, args),
        "workflows:clearRecommendation" => clear_recommendation(host, args),
        "workflows:recommendAgent" => recommend_agent(host, args),
        _ => Err(failure(format!("Unsupported workflows channel: {channel}"))),
    }
}
