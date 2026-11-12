//! Workflows and policy orchestration in-process service.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{SecondsFormat, Utc};
use praxis_core::git::run_work::repository_root;
use praxis_host::HostContext;
use praxis_workflows::gates::{
    GateBypassInput, approve_stage, bypass_gate, failing_gate_findings, resolve_approval_target,
    skip_approval as gates_skip_approval,
};
use praxis_workflows::run::{
    CreateWorkflowRunInput, DeclaredArtifact, LoopDecisionKind, ReworkOptions, WorkflowRun,
    WorkflowRunCommand, allow_ai_merge_resolution, apply_workflow_run_command, create_workflow_run,
    is_run_settled, rework_workflow_run,
};
use praxis_workflows::scheduler::advance_joins;
use praxis_workflows::types::{
    CheckFindings, WorkflowArtifactKind, WorkflowDefinition, WorkflowGateKind, WorkflowNode,
    WorkflowPolicyProfile, WorkflowScope,
};
use praxis_workflows::validation::validate_workflow;
use serde_json::{Value, json};

use super::storage::{self, Catalog};
use super::workflow_engine;
use super::workflow_summary::{self, summarize_workflow_run};
use super::{Result, failure, runtime, text};

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

/// Every stored run, for the scheduled-run runner.
pub fn all_runs(host: &HostContext) -> Vec<WorkflowRun> {
    get_runs(host)
}

/// The project's workflow stages (board columns), for moving tickets by category.
pub fn project_workflow_stages(
    host: &HostContext,
    project_id: &str,
) -> Option<Vec<praxis_contracts::ProjectWorkflowStage>> {
    let catalog =
        storage::Catalog::load_readonly(&host.config().user_data_dir, &host.config().settings_path)
            .ok()?;
    let project = catalog.require(storage::PROJECTS, project_id).ok()?;
    serde_json::from_value(project.get("workflowStages")?.clone()).ok()
}

/// What a schedule may run on a project: its own workflows, then the templates it could instantiate.
pub fn workflow_choices_for(host: &HostContext, project_id: &str) -> Vec<Value> {
    let mut by_id: Vec<(String, Value)> = Vec::new();
    for definition in project_definition_values(host, project_id)
        .into_iter()
        .chain(all_template_values(host, project_id))
    {
        let id = definition["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() || by_id.iter().any(|(existing, _)| *existing == id) {
            continue;
        }
        by_id.push((
            id.clone(),
            json!({
                "workflowId": id,
                "name": definition["name"],
                "trigger": definition["trigger"].as_str().unwrap_or("on-demand"),
            }),
        ));
    }
    by_id.into_iter().map(|(_, v)| v).collect()
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

fn embedded_templates() -> Value {
    serde_json::from_str(include_str!("../../workflow-templates.json"))
        .unwrap_or_else(|_| json!({ "builtIn": [], "marketplace": [] }))
}

/// Embedded templates with the marketplace tier completed: installed `workflow-template`
/// add-ons come first (global scope) and supersede an embedded template with the same id.
fn templates_with_addons(host: &HostContext) -> Value {
    let mut embedded = embedded_templates();
    let from_addons: Vec<Value> =
        super::marketplace::workflow_templates(&host.config().user_data_dir)
            .into_iter()
            .filter(|raw| {
                raw.get("id").and_then(Value::as_str).is_some()
                    && raw.get("nodes").is_some_and(Value::is_array)
            })
            .map(|mut raw| {
                raw["scope"] = json!("global");
                raw
            })
            .collect();
    let addon_ids: Vec<String> = from_addons
        .iter()
        .filter_map(|t| t["id"].as_str().map(str::to_string))
        .collect();
    let bundled = embedded
        .get("marketplace")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|t| {
            t["id"]
                .as_str()
                .is_none_or(|id| !addon_ids.iter().any(|a| a == id))
        });
    embedded["marketplace"] = Value::Array(from_addons.into_iter().chain(bundled).collect());
    embedded
}

// ── Project & Template definitions ──────────────────────────────────────

fn project_workflows_key(project_id: &str) -> String {
    format!("praxis.projectWorkflows.{project_id}")
}

/// The project's attached workspace folder, when it has one.
pub fn project_folder(host: &HostContext, project_id: &str) -> Option<PathBuf> {
    let catalog =
        storage::Catalog::load_readonly(&host.config().user_data_dir, &host.config().settings_path)
            .ok()?;
    let project = catalog.require(storage::PROJECTS, project_id).ok()?;
    project["workspaceFolder"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn projects_exist(host: &HostContext, project_id: &str) -> bool {
    storage::Catalog::load_readonly(&host.config().user_data_dir, &host.config().settings_path)
        .ok()
        .is_some_and(|catalog| catalog.require(storage::PROJECTS, project_id).is_ok())
}

const PROJECT_WORKFLOWS_DIR: &str = ".praxis/workflows";

/// Mirrors core's `workflowFileName`: an id that cannot be a safe file name is refused.
fn workflow_file_name(id: &str) -> Result<String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(failure("A workflow id is required."));
    }
    if trimmed == "." || trimmed == ".." || trimmed.contains(['/', '\\', '\0']) {
        return Err(failure(format!("Unsafe workflow id: {id}")));
    }
    if trimmed.starts_with('.') {
        return Err(failure(format!(
            "A workflow id may not start with a dot: {id}"
        )));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(failure(format!(
            "A workflow id may only contain letters, digits, dot, underscore, and hyphen: {id}"
        )));
    }
    if trimmed.len() > 128 {
        return Err(failure(format!("Workflow id is too long: {id}")));
    }
    Ok(format!("{trimmed}.json"))
}

/// Definitions committed under `<folder>/.praxis/workflows`, in file-name order.
fn committed_definitions(folder: &std::path::Path) -> Vec<Value> {
    let root = folder.join(PROJECT_WORKFLOWS_DIR);
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut names: Vec<PathBuf> = entries
        .filter_map(std::result::Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(|v| serde_json::from_value::<WorkflowDefinition>(v.clone()).is_ok())
        .collect()
}

fn draft_definitions(host: &HostContext, project_id: &str) -> Vec<Value> {
    read_workflows_json(host)
        .get(project_workflows_key(project_id))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Committed definitions are authoritative; a draft shows through only until its id is committed.
fn project_definition_values(host: &HostContext, project_id: &str) -> Vec<Value> {
    let committed = project_folder(host, project_id)
        .map(|folder| committed_definitions(&folder))
        .unwrap_or_default();
    let committed_ids: Vec<String> = committed
        .iter()
        .filter_map(|d| d.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut all = committed;
    all.extend(draft_definitions(host, project_id).into_iter().filter(|d| {
        d.get("id")
            .and_then(Value::as_str)
            .is_none_or(|id| !committed_ids.iter().any(|c| c == id))
    }));
    all
}

fn get_project_definitions(host: &HostContext, project_id: &str) -> Vec<WorkflowDefinition> {
    project_definition_values(host, project_id)
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect()
}

fn write_drafts(host: &HostContext, project_id: &str, drafts: Vec<Value>) -> Result<()> {
    let mut root = read_workflows_json(host);
    if !root.is_object() {
        root = json!({});
    }
    root[project_workflows_key(project_id)] = Value::Array(drafts);
    write_workflows_json(host, &root)
}

fn save_draft(host: &HostContext, project_id: &str, definition: Value) -> Result<()> {
    let id = definition
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut drafts: Vec<Value> = draft_definitions(host, project_id)
        .into_iter()
        .filter(|d| d.get("id").and_then(Value::as_str) != Some(id.as_str()))
        .collect();
    drafts.push(definition);
    write_drafts(host, project_id, drafts)
}

fn drop_draft(host: &HostContext, project_id: &str, workflow_id: &str) -> Result<()> {
    let drafts = draft_definitions(host, project_id)
        .into_iter()
        .filter(|d| d.get("id").and_then(Value::as_str) != Some(workflow_id))
        .collect();
    write_drafts(host, project_id, drafts)
}

/// A folder-backed project commits `.praxis/workflows/<id>.json`; a folderless one keeps a draft.
fn persist_project_workflow(
    host: &HostContext,
    project_id: &str,
    definition: &Value,
) -> Result<()> {
    let Some(folder) = project_folder(host, project_id) else {
        return save_draft(host, project_id, definition.clone());
    };
    let id = definition.get("id").and_then(Value::as_str).unwrap_or("");
    let root = folder.join(PROJECT_WORKFLOWS_DIR);
    let file = root.join(workflow_file_name(id)?);
    fs::create_dir_all(&root).map_err(failure)?;
    let body = serde_json::to_string_pretty(definition).map_err(failure)?;
    fs::write(file, format!("{body}\n")).map_err(failure)?;
    drop_draft(host, project_id, id)
}

fn save_project_definition(
    host: &HostContext,
    project_id: &str,
    definition: WorkflowDefinition,
) -> Result<()> {
    let value = serde_json::to_value(definition).map_err(failure)?;
    persist_project_workflow(host, project_id, &value)
}

fn remove_project_definition(
    host: &HostContext,
    project_id: &str,
    workflow_id: &str,
) -> Result<()> {
    drop_draft(host, project_id, workflow_id)?;
    if let Some(folder) = project_folder(host, project_id) {
        let file = folder
            .join(PROJECT_WORKFLOWS_DIR)
            .join(workflow_file_name(workflow_id)?);
        let _ = fs::remove_file(file);
    }
    Ok(())
}

// ── Channel Handlers ────────────────────────────────────────────────────

// ── Workspace trust ──────────────────────────────────────────────────────

/// What a person must review before a project workflow's commands may run (`projectWorkflowTrust`).
pub struct TrustState {
    pub trusted: bool,
    pub fingerprint: String,
    pub commands: Vec<String>,
    pub key: String,
}

fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn untracked_trust() -> TrustState {
    TrustState {
        trusted: true,
        fingerprint: String::new(),
        commands: Vec::new(),
        key: String::new(),
    }
}

/// A definition committed to the repository is only trusted once its fingerprint is approved here.
pub fn project_workflow_trust(
    host: &HostContext,
    project_id: &str,
    workflow_id: &str,
    definition: Option<&Value>,
    require_snapshot_trust: bool,
) -> TrustState {
    let Some(folder) = project_folder(host, project_id) else {
        return untracked_trust();
    };
    let root = fs::canonicalize(&folder).unwrap_or(folder);
    let entry = committed_definitions(&root)
        .into_iter()
        .find(|d| d.get("id").and_then(Value::as_str) == Some(workflow_id));
    if entry.is_none() && (!require_snapshot_trust || definition.is_none()) {
        return untracked_trust();
    }
    let reviewed = definition.cloned().or(entry).unwrap_or(Value::Null);
    // Run titles are display metadata; all executable nodes and edges stay fingerprinted.
    let mut execution = reviewed.clone();
    if let Some(obj) = execution.as_object_mut() {
        obj.remove("name");
    }
    let fingerprint = sha256_hex(&serde_json::to_string(&execution).unwrap_or_default());
    let key = format!(
        "praxis.workflowTrust.v1:{}",
        sha256_hex(&format!("{}\0{workflow_id}", root.to_string_lossy()))
    );
    let commands = reviewed
        .get("nodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|node| {
                    let name = node["name"].as_str().unwrap_or("");
                    match node["type"].as_str() {
                        Some("check") => {
                            let args: Vec<String> = node["args"]
                                .as_array()
                                .map(|a| a.iter().map(Value::to_string).collect())
                                .unwrap_or_default();
                            Some(format!(
                                "{name}: {} {}",
                                node["command"].as_str().unwrap_or(""),
                                args.join(" ")
                            ))
                        }
                        Some("agent-task") => Some(format!(
                            "{name}: AI agent ({} tools)",
                            node["agent"]["toolMode"].as_str().unwrap_or("full")
                        )),
                        Some("deployment") => Some(format!(
                            "{name}: deployment profile {}",
                            node["deploymentProfileId"].as_str().unwrap_or("")
                        )),
                        _ => None,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let trusted = read_workflows_json(host)
        .get(&key)
        .and_then(Value::as_str)
        .is_some_and(|stored| stored == fingerprint);
    TrustState {
        trusted,
        fingerprint,
        commands,
        key,
    }
}

fn set_trust(host: &HostContext, key: &str, fingerprint: &str) -> Result<()> {
    let _guard = workflow_engine::runs_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut root = read_workflows_json(host);
    if !root.is_object() {
        root = json!({});
    }
    root[key] = json!(fingerprint);
    write_workflows_json(host, &root)
}

pub fn project_trust(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let workflow_id = text(args, 1)?;
    let definition = runnable_definition(host, project_id, workflow_id);
    let state = project_workflow_trust(host, project_id, workflow_id, definition.as_ref(), false);
    Ok(json!({
        "trusted": state.trusted,
        "fingerprint": state.fingerprint,
        "commands": state.commands,
    }))
}

pub fn approve_project_trust(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let workflow_id = text(args, 1)?;
    let fingerprint = args.get(2).and_then(Value::as_str).unwrap_or("");
    let definition = runnable_definition(host, project_id, workflow_id);
    let state = project_workflow_trust(host, project_id, workflow_id, definition.as_ref(), false);
    if state.key.is_empty() || fingerprint.is_empty() || state.fingerprint != fingerprint {
        return Err(failure("The workflow changed; review its commands again."));
    }
    set_trust(host, &state.key, fingerprint)?;
    Ok(Value::Null)
}

pub fn list_templates(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let embedded = templates_with_addons(host);
    let mut list = Vec::new();
    if let Some(built_ins) = embedded.get("builtIn").and_then(Value::as_array) {
        for t in built_ins {
            list.push(json!({
                "definition": t,
                "source": "built-in"
            }));
        }
    }
    // Installed workflow-template add-ons (and the bundled marketplace set) are their own tier.
    for t in embedded
        .get("marketplace")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        list.push(json!({ "definition": t, "source": "marketplace" }));
    }
    for def in get_project_definitions(host, project_id) {
        list.push(json!({
            "definition": def,
            "source": "project"
        }));
    }
    Ok(json!(list))
}

pub fn get_recommended_template(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let catalog = storage::Catalog::load_readonly(
        &host.config().user_data_dir,
        &host.config().settings_path,
    )?;
    Ok(catalog
        .require(storage::PROJECTS, project_id)
        .map(|p| p["recommendedWorkflowTemplate"].clone())
        .unwrap_or(Value::Null))
}

const TEMPLATE_SYSTEM_PROMPT: &str = "You are helping someone pick a workflow template for a software delivery project.\nGiven the project's name, purpose, and a short brief, and a list of available workflow templates, pick the\nsingle best-fitting template. Respond with exactly one fenced JSON code block and nothing else:\n\n```json\n{ \"templateId\": \"<one of the listed template ids, verbatim>\", \"rationale\": \"<one sentence, specific to this project>\" }\n```";

/// The prompt asking which template fits (`buildPrompt` in `workflowTemplateRecommendation.ts`).
fn template_prompt(project: &Value, candidates: &[Value]) -> String {
    let brief: Vec<String> = project["brief"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| {
            v.as_str()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| format!("- {k}: {v}"))
        })
        .collect();
    let catalog: Vec<String> = candidates
        .iter()
        .map(|c| {
            format!(
                "- {}: {}{}",
                c["templateId"].as_str().unwrap_or(""),
                c["name"].as_str().unwrap_or(""),
                c["description"]
                    .as_str()
                    .map(|d| format!(" — {d}"))
                    .unwrap_or_default()
            )
        })
        .collect();
    let name = project["name"]
        .as_str()
        .filter(|n| !n.is_empty())
        .unwrap_or("(untitled project)");
    let purpose = project["purpose"]
        .as_str()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or("(none provided)");
    let mut lines = vec![
        format!("Project name: {name}"),
        format!("Purpose: {purpose}"),
    ];
    if !brief.is_empty() {
        lines.push(format!("Brief:\n{}", brief.join("\n")));
    }
    lines.push(format!(
        "\nAvailable workflow templates:\n{}",
        catalog.join("\n")
    ));
    lines.push("\nRecommend exactly one template id from the list above.".into());
    lines.join("\n")
}

/// The `{ <key>, rationale }` the model answered, checked against the ids it was offered.
fn parse_choice(reply: &str, key: &str, valid: &[String], noun: &str) -> Result<(String, String)> {
    let parsed: Value = serde_json::from_str(&extract_json_block(reply))
        .map_err(|_| failure("The AI recommendation response was not valid JSON."))?;
    if !parsed.is_object() || parsed.get(key).is_none() {
        return Err(failure(format!(
            "The AI recommendation response did not include a {key}."
        )));
    }
    let id = parsed[key].as_str().map(str::trim).unwrap_or("").to_owned();
    if !valid.contains(&id) {
        return Err(failure(format!(
            "The AI recommended \"{id}\", which is not one of the offered {noun}."
        )));
    }
    let rationale = parsed["rationale"]
        .as_str()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .unwrap_or("No rationale was given.")
        .to_owned();
    Ok((id, rationale))
}

pub fn recommend_template(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let catalog = storage::Catalog::load_readonly(
        &host.config().user_data_dir,
        &host.config().settings_path,
    )?;
    let project = catalog
        .require(storage::PROJECTS, project_id)
        .map_err(|_| failure(format!("Project {project_id} was not found.")))?;
    // Only what the New Workflow dialog offers: project templates are excluded there, so here too.
    let candidates: Vec<Value> = list_templates(host, &[json!(project_id)])?
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["source"] != "project")
        .map(|t| json!({ "templateId": t["definition"]["id"], "name": t["definition"]["name"], "description": t["definition"]["description"] }))
        .collect();
    if candidates.is_empty() {
        return Err(failure(
            "No workflow templates are available to recommend from.",
        ));
    }
    let (connection, model) = recommendation_connection(host)?;
    let provider = connection.provider.clone();
    let (reply, usage) = runtime::block_on(super::api_host::run_provider_prompt(
        &connection,
        &model,
        TEMPLATE_SYSTEM_PROMPT,
        &template_prompt(&project, &candidates),
        None,
        |_| {},
    ))
    .map_err(failure)?;
    let ids: Vec<String> = candidates
        .iter()
        .filter_map(|c| c["templateId"].as_str().map(str::to_owned))
        .collect();
    let (template_id, rationale) = parse_choice(&reply, "templateId", &ids, "templates")?;
    let stored = json!({ "templateId": template_id, "rationale": rationale, "model": model, "computedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true) });
    let response = host.dispatch_rpc(praxis_contracts::RustRpcRequest {
        id: "recommend-template".into(),
        channel: "projects:update".into(),
        args: vec![
            json!(project_id),
            json!({ "recommendedWorkflowTemplate": stored }),
        ],
    });
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| failure("The recommendation could not be saved.")));
    }
    Ok(
        json!({ "templateId": template_id, "rationale": rationale, "model": model, "provider": provider, "usage": usage }),
    )
}

const TIER_SYSTEM_PROMPT: &str = "You are helping someone choose how capable a model each stage of a software delivery workflow needs.\nTiers: \"fast\" (cheap and quick: summaries, formatting, simple checks of text), \"standard\" (routine review, test\nauthoring, analysis), \"strong\" (hard reasoning: writing or changing production code, security review, subtle\ncorrectness review). A stage that fails is retried one tier higher automatically, so prefer the cheapest tier that\nwill usually succeed. Respond with exactly one fenced JSON code block and nothing else:\n\n```json\n{ \"stages\": { \"<nodeId, verbatim>\": { \"tier\": \"fast|standard|strong\", \"rationale\": \"<one short sentence>\" } } }\n```";

/// The provider a one-shot recommendation runs on (`resolveRecommendationProvider`): the explicit
/// Recommendations provider, else the active one when it is a configured API provider, else the
/// first configured API provider.
fn recommendation_connection(
    host: &HostContext,
) -> Result<(super::api_host::ApiConnection, String)> {
    use praxis_ai::providers::registry::{DescriptorKind, built_in_descriptors};
    let (explicit, active, custom): (Option<String>, String, Vec<String>) = {
        let settings = host.settings().read();
        (
            settings
                .ai
                .recommendation_provider
                .clone()
                .filter(|p| !p.is_empty()),
            settings.ai.active_provider.clone(),
            settings
                .ai
                .custom_providers
                .iter()
                .flatten()
                .filter_map(|c| {
                    serde_json::to_value(c).ok()?["id"]
                        .as_str()
                        .map(str::to_string)
                })
                .collect(),
        )
    };
    let ready = |provider: &str| {
        super::ai_providers::api_connection(host, provider)
            .ok()
            .filter(|(connection, _)| connection.options.api_key.is_some())
    };
    if let Some(provider) = explicit {
        return ready(&provider).ok_or_else(|| {
            failure(format!(
                "{provider} is not configured — add an API key in Settings → AI, or change the Recommendations provider setting."
            ))
        });
    }
    let mut order = vec![active];
    order.extend(
        built_in_descriptors()
            .into_iter()
            .filter(|d| d.kind == DescriptorKind::Api)
            .map(|d| d.id),
    );
    order.extend(custom);
    order
        .iter()
        .find_map(|provider| ready(provider))
        .ok_or_else(|| {
            failure("No AI provider is configured for recommendations — add an API key in Settings → AI.")
        })
}

fn extract_json_block(text: &str) -> String {
    let fenced = regex::Regex::new(r"(?is)```json\s*(.*?)```")
        .ok()
        .and_then(|re| re.captures(text).map(|c| c[1].to_string()))
        .or_else(|| {
            regex::Regex::new(r"(?s)```\s*(.*?)```")
                .ok()
                .and_then(|re| re.captures(text).map(|c| c[1].to_string()))
        });
    fenced
        .unwrap_or_else(|| text.to_string())
        .trim()
        .to_string()
}

pub fn recommend_model_tiers(host: &HostContext, args: &[Value]) -> Result<Value> {
    use praxis_workflows::stage_model::default_tier_for_stage;
    let project_id = text(args, 0)?;
    if !projects_exist(host, project_id) {
        return Err(failure(format!("Project {project_id} was not found.")));
    }
    let definition = args.get(1).cloned().unwrap_or(Value::Null);
    let agents: Vec<&Value> = definition["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| n["type"] == "agent-task")
        .collect();
    if agents.is_empty() {
        return Err(failure(
            "This workflow has no agent stages to choose a model for.",
        ));
    }
    let mut lines = vec![format!(
        "Workflow: {}",
        definition["name"].as_str().unwrap_or("")
    )];
    if let Some(description) = definition["description"].as_str().filter(|d| !d.is_empty()) {
        lines.push(format!("Description: {description}"));
    }
    lines.push(String::new());
    lines.push("Stages:".into());
    let stages: Vec<String> = agents
        .iter()
        .map(|node| {
            let mut parts = vec![
                format!("- id: {}", node["id"].as_str().unwrap_or("")),
                format!("  name: {}", node["name"].as_str().unwrap_or("")),
                format!(
                    "  writes code to the worktree: {}",
                    if node["mutatesWorktree"] == true {
                        "yes"
                    } else {
                        "no"
                    }
                ),
            ];
            if let Some(gate) = node["satisfiesGate"].as_str() {
                parts.push(format!("  evidence for the {gate} gate"));
            }
            let instructions: String = node["instructions"]
                .as_str()
                .unwrap_or("")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(400)
                .collect();
            parts.push(format!(
                "  instructions: {}",
                if instructions.is_empty() {
                    "(none)"
                } else {
                    &instructions
                }
            ));
            parts.join("\n")
        })
        .collect();
    lines.push(stages.join("\n"));
    let prompt = lines.join("\n");

    let (connection, model) = recommendation_connection(host)?;
    let provider = connection.provider.clone();
    let (reply, usage) = runtime::block_on(super::api_host::run_provider_prompt(
        &connection,
        &model,
        TIER_SYSTEM_PROMPT,
        &prompt,
        None,
        |_| {},
    ))
    .map_err(failure)?;
    let parsed: Value = serde_json::from_str(&extract_json_block(&reply))
        .map_err(|_| failure("The AI model-tier response was not valid JSON."))?;
    let Some(answered) = parsed["stages"].as_object() else {
        return Err(failure(
            "The AI model-tier response did not include a \"stages\" object.",
        ));
    };
    let mut result = serde_json::Map::new();
    for node in agents {
        let id = node["id"].as_str().unwrap_or("");
        let entry = answered.get(id);
        let tier = entry
            .and_then(|e| e["tier"].as_str())
            .filter(|t| ["fast", "standard", "strong"].contains(t));
        result.insert(
            id.to_string(),
            match tier {
                Some(tier) => json!({
                    "tier": tier,
                    "rationale": entry
                        .and_then(|e| e["rationale"].as_str())
                        .map(str::trim)
                        .filter(|r| !r.is_empty())
                        .unwrap_or("No rationale was given."),
                    "defaulted": false,
                }),
                None => json!({
                    "tier": default_tier_for_stage(
                        node["mutatesWorktree"] == true,
                        node["satisfiesGate"].is_string()
                    ).to_string(),
                    "rationale": "The model gave no usable answer for this stage, so the default for what it does was used.",
                    "defaulted": true,
                }),
            },
        );
    }
    Ok(json!({ "stages": result, "model": model, "provider": provider, "usage": usage }))
}

/// The agent and skill dependencies of a workflow's agent stages, each `installed`, `available`
/// (a bundled definition can be installed on selection) or `missing` (`extractWorkflowDependencies`).
fn extract_dependencies(catalog: &Value, template: &Value) -> Vec<Value> {
    use praxis_core::agent_runtime::bundled::{bundled_skill, is_bundled_agent};
    let list = |key: &str| {
        catalog
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let has_runtime_hosts = catalog.get("runtimeHosts").is_some_and(Value::is_array);
    let hosts = if has_runtime_hosts {
        list("runtimeHosts")
    } else {
        list("agents")
    };
    let has_profiles = catalog.get("profiles").is_some_and(Value::is_array);
    let profiles = list("profiles");
    let skills = list("skills");

    struct Entry {
        profile_id: String,
        host_id: String,
        provider_id: Option<String>,
        scope: String,
        skills: Vec<String>,
        node_ids: Vec<String>,
    }
    let mut entries: Vec<(String, Entry)> = Vec::new();
    for node in template["nodes"].as_array().into_iter().flatten() {
        if node["type"] != "agent-task" {
            continue;
        }
        let agent = &node["agent"];
        let agent_id = agent["agentId"].as_str().unwrap_or("");
        let profile_id = agent["profileId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(agent_id)
            .to_string();
        let host_id = agent["hostId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(agent_id)
            .to_string();
        let provider = agent["providerId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let scope = agent["scope"].as_str().unwrap_or("global").to_string();
        let key = format!(
            "{scope}:{profile_id}:{host_id}:{}",
            provider.clone().unwrap_or_default()
        );
        let position = entries.iter().position(|(k, _)| *k == key);
        let index = position.unwrap_or_else(|| {
            entries.push((
                key,
                Entry {
                    profile_id,
                    host_id,
                    provider_id: provider,
                    scope,
                    skills: Vec::new(),
                    node_ids: Vec::new(),
                },
            ));
            entries.len() - 1
        });
        let entry = &mut entries[index].1;
        entry
            .node_ids
            .push(node["id"].as_str().unwrap_or("").to_string());
        for name in agent["skillNames"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !entry.skills.iter().any(|s| s == name) {
                entry.skills.push(name.to_string());
            }
        }
    }

    let usable =
        |v: &Value| v["trusted"] == true && v["errors"].as_array().is_none_or(Vec::is_empty);
    entries
        .into_iter()
        .map(|(_, entry)| {
            let host = hosts.iter().find(|h| h["manifest"]["id"] == entry.host_id.as_str());
            let host_installed = host.is_some_and(usable);
            let profile = profiles.iter().find(|p| p["profile"]["id"] == entry.profile_id.as_str());
            let profile_installed = if has_profiles {
                profile.is_some_and(|p| p["trusted"] == true && p["error"].as_str().is_none_or(str::is_empty))
            } else {
                entry.profile_id == entry.host_id
            };
            let missing_skills: Vec<&String> = entry
                .skills
                .iter()
                .filter(|name| !skills.iter().any(|s| s["metadata"]["name"] == name.as_str()))
                .collect();
            let bundled_binding = entry.profile_id == entry.host_id && is_bundled_agent(&entry.host_id);
            let host_available = host_installed || is_bundled_agent(&entry.host_id);
            let profile_available = profile_installed || bundled_binding;
            let skills_available = missing_skills.iter().all(|name| bundled_skill(name).is_some());
            let (status, reason) = if host_installed && profile_installed && missing_skills.is_empty() {
                ("installed", None)
            } else if host_available && profile_available && skills_available {
                let mut missing = Vec::new();
                if !profile_installed {
                    missing.push(format!("profile \"{}\"", entry.profile_id));
                }
                if !host_installed {
                    missing.push(format!("runtime host \"{}\"", entry.host_id));
                }
                if !missing_skills.is_empty() {
                    missing.push(format!(
                        "skills ({})",
                        missing_skills.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
                    ));
                }
                ("available", Some(format!("{} available for installation.", missing.join(", "))))
            } else if !profile_available {
                ("missing", Some(format!("Agent profile \"{}\" is not installed or available.", entry.profile_id)))
            } else if !host_available {
                ("missing", Some(format!("Runtime host \"{}\" is not installed or available.", entry.host_id)))
            } else {
                (
                    "missing",
                    Some(format!(
                        "Required skills ({}) are not available.",
                        missing_skills
                            .iter()
                            .filter(|name| bundled_skill(name).is_none())
                            .map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )),
                )
            };
            let mut dependency = json!({
                "agentId": entry.host_id, "profileId": entry.profile_id, "hostId": entry.host_id,
                "scope": entry.scope, "skillNames": entry.skills, "nodeIds": entry.node_ids, "status": status,
            });
            if let Some(provider) = entry.provider_id {
                dependency["providerId"] = json!(provider);
            }
            if let Some(reason) = reason {
                dependency["reason"] = json!(reason);
            }
            dependency
        })
        .collect()
}

pub fn template_readiness(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let catalog = agent_catalog(host);
    let mut templates = all_template_values(host, project_id);
    templates.dedup_by(|a, b| a["id"] == b["id"]);
    let list: Vec<Value> = templates
        .iter()
        .map(|template| {
            let structure = validate_workflow(template, None);
            let mut blocking = serde_json::Map::new();
            for node in template["nodes"].as_array().into_iter().flatten() {
                let blockers = preflight_blockers(&catalog, std::slice::from_ref(node), None);
                if let Some(first) = blockers.first() {
                    // The message alone, without its remediation sentence.
                    let message = first.split(". ").next().unwrap_or(first);
                    blocking.insert(
                        node["id"].as_str().unwrap_or("").to_string(),
                        json!(if message.ends_with('.') {
                            message.to_string()
                        } else {
                            format!("{message}.")
                        }),
                    );
                }
            }
            let dependencies = extract_dependencies(&catalog, template);
            let all_resolvable = dependencies
                .iter()
                .all(|d| matches!(d["status"].as_str(), Some("installed" | "available")));
            let has_available = dependencies.iter().any(|d| d["status"] == "available");
            json!({
                "templateId": template["id"],
                "structureOk": structure.valid(),
                "agentsOk": blocking.is_empty(),
                "blockingByNode": blocking,
                "dependencies": dependencies,
                "autoInstallable": all_resolvable && has_available,
            })
        })
        .collect();
    Ok(json!(list))
}

pub fn catalog(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let embedded = templates_with_addons(host);
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
    Ok(project_definition_values(host, project_id)
        .into_iter()
        .find(|d| d.get("id").and_then(Value::as_str) == Some(workflow_id))
        .unwrap_or(Value::Null))
}

/// The tier a new workflow starts each agent stage on (`defaultTierForStage`).
fn default_tier_for_stage(node: &Value) -> &'static str {
    if node.get("mutatesWorktree").and_then(Value::as_bool) == Some(true) {
        "strong"
    } else if node.get("satisfiesGate").is_some_and(|g| !g.is_null()) {
        "standard"
    } else {
        "fast"
    }
}

/// `instantiateTemplateForProject`: a deep, project-scoped, version-1 copy of a template.
fn instantiate_template(
    template: &Value,
    project_id: &str,
    at: &str,
    new_id: Option<&str>,
    new_name: Option<&str>,
) -> Value {
    let mut copy = template.clone();
    if let Some(obj) = copy.as_object_mut() {
        obj.remove("builtIn");
        if let Some(nodes) = obj.get_mut("nodes").and_then(Value::as_array_mut) {
            for node in nodes {
                let is_agent = node.get("type").and_then(Value::as_str) == Some("agent-task");
                let has_model = node.get("model").is_some_and(|v| !v.is_null() && v != "");
                let has_tier = node.get("modelTier").is_some_and(|v| !v.is_null());
                if is_agent && !has_model && !has_tier {
                    let tier = default_tier_for_stage(node);
                    node["modelTier"] = json!(tier);
                }
            }
        }
        let template_id = template.get("id").and_then(Value::as_str).unwrap_or("");
        let template_name = template.get("name").cloned().unwrap_or(Value::Null);
        obj.insert(
            "id".into(),
            json!(new_id.map_or_else(|| format!("{template_id}-{project_id}"), str::to_string)),
        );
        obj.insert(
            "name".into(),
            new_name.map_or(template_name, |name| json!(name)),
        );
        obj.insert("scope".into(), json!("project"));
        obj.insert("projectId".into(), json!(project_id));
        obj.insert("version".into(), json!(1));
        obj.insert("createdAt".into(), json!(at));
        obj.insert("updatedAt".into(), json!(at));
    }
    copy
}

/// Every template a project can instantiate: built-in, marketplace, then its own.
fn all_template_values(host: &HostContext, project_id: &str) -> Vec<Value> {
    let embedded = templates_with_addons(host);
    let mut all: Vec<Value> = Vec::new();
    for key in ["builtIn", "marketplace"] {
        if let Some(list) = embedded.get(key).and_then(Value::as_array) {
            all.extend(list.iter().cloned());
        }
    }
    all.extend(project_definition_values(host, project_id));
    all
}

/// Installs the agents and skills a template names that Praxis ships but the user has not yet
/// installed (`ensureWorkflowDependenciesInstalled`), then refreshes the catalog.
fn ensure_workflow_dependencies_installed(host: &HostContext, template: &Value) {
    let dir = &host.config().user_data_dir;
    let agents_dir = dir.join("agents");
    let skills_dir = dir.join("skills");
    let mut installed_any = false;
    for node in template["nodes"].as_array().into_iter().flatten() {
        if node["type"] != "agent-task" {
            continue;
        }
        let agent_id = node["agent"]["agentId"].as_str().unwrap_or("");
        if !agent_id.is_empty()
            && !agents_dir.join(agent_id).join("agent.json").exists()
            && praxis_core::agent_runtime::bundled::install_available_agent(agent_id, &agents_dir)
        {
            installed_any = true;
        }
        for name in node["agent"]["skillNames"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !skills_dir.join(name).join("SKILL.md").exists()
                && praxis_core::agent_runtime::bundled::install_available_skill(name, &skills_dir)
            {
                installed_any = true;
            }
        }
    }
    if installed_any {
        super::agent_runtime::refresh(host, dir);
    }
}

pub fn instantiate(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let template_id = text(args, 1)?;
    let name_override = args
        .get(2)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());

    let template = all_template_values(host, project_id)
        .into_iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(template_id))
        .ok_or_else(|| failure(format!("Template {template_id} was not found.")))?;
    ensure_workflow_dependencies_installed(host, &template);
    let copy = instantiate_template(&template, project_id, &now(), None, name_override);
    let result = validate_workflow(&copy, None);
    if !result.valid() {
        let detail: Vec<String> = result.errors.iter().map(|i| i.message.clone()).collect();
        return Err(failure(format!(
            "The template did not produce a valid workflow: {}",
            detail.join("; ")
        )));
    }
    save_draft(host, project_id, copy.clone())?;
    Ok(copy)
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
        return Err(failure(format!(
            "Workflow is invalid: {}",
            detail.join("; ")
        )));
    }
    // Reject an id that could not be committed as a file, even for a folderless project.
    workflow_file_name(val.get("id").and_then(Value::as_str).unwrap_or(""))?;
    let mut next = val.clone();
    next["updatedAt"] = json!(now());
    persist_project_workflow(host, project_id, &next)?;
    let trust = project_workflow_trust(
        host,
        project_id,
        next["id"].as_str().unwrap_or(""),
        Some(&next),
        false,
    );
    if !trust.key.is_empty() {
        set_trust(host, &trust.key, &trust.fingerprint)?;
    }
    Ok(next)
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

// ── Runs ─────────────────────────────────────────────────────────────────

pub fn policy_for(host: &HostContext, project_id: &str) -> Option<WorkflowPolicyProfile> {
    policy_value_for(host, project_id).and_then(|v| serde_json::from_value(v).ok())
}

/// The run monitor's view of `run`, composed with the project's effective policy.
pub fn summarize(host: &HostContext, run: &WorkflowRun) -> Value {
    summarize_workflow_run(run, policy_for(host, &run.project_id).as_ref())
}

/// The live Agent Hub catalog (`agentRuntime:list`) as preflight reads it.
fn agent_catalog(host: &HostContext) -> Value {
    // Read directly: this runs under the profile lock, which a nested RPC would wait on forever.
    super::agent_runtime::list(host, &host.config().user_data_dir)
}

/// Resolves each agent stage against what is discovered and trusted right now (`preflightWorkflow`).
/// Returns the "message remediation" text of every failure.
fn preflight_blockers(catalog: &Value, nodes: &[Value], policy: Option<&Value>) -> Vec<String> {
    let list = |key: &str| {
        catalog
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let hosts = if catalog.get("runtimeHosts").is_some_and(Value::is_array) {
        list("runtimeHosts")
    } else {
        list("agents")
    };
    let profiles = list("profiles");
    let skills = list("skills");
    let require_trust = policy
        .and_then(|p| p.get("requireTrustedAgents"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut blockers = Vec::new();
    for node in nodes {
        if node["type"] != "agent-task" {
            continue;
        }
        let agent_ref = &node["agent"];
        let scope = agent_ref["scope"].as_str().unwrap_or("global");
        let agent_id = agent_ref["agentId"].as_str().unwrap_or("");
        let host_id = agent_ref["hostId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(agent_id);
        let profile_id = agent_ref["profileId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(agent_id);
        let mut add = |message: String, remediation: String| {
            blockers.push(format!("{message} {remediation}"))
        };
        let Some(agent) = hosts.iter().find(|h| h["manifest"]["id"] == host_id) else {
            add(
                format!("Agent \"{host_id}\" is not in the {scope} catalog."),
                format!(
                    "Install or import an agent with id \"{host_id}\", or point this stage at one that exists."
                ),
            );
            continue;
        };
        if agent["scope"].as_str().is_some_and(|s| s != scope) {
            add(
                format!(
                    "Agent \"{host_id}\" belongs to the {} catalog, not the {scope} catalog.",
                    agent["scope"].as_str().unwrap_or("")
                ),
                format!(
                    "Select a {scope}-scoped host with id \"{host_id}\", or change the stage scope."
                ),
            );
        }
        let profile = profiles.iter().find(|p| p["profile"]["id"] == profile_id);
        let wants_profile = agent_ref["profileId"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
            || !profiles.is_empty();
        if wants_profile && profile.is_none() {
            add(
                format!("Agent profile \"{profile_id}\" is not in the {scope} catalog."),
                format!(
                    "Create or import an AGENT.md profile with id \"{profile_id}\", or select an existing profile."
                ),
            );
        }
        if let Some(profile) = profile {
            if profile["scope"].as_str().is_some_and(|s| s != scope) {
                add(
                    format!(
                        "Agent profile \"{profile_id}\" belongs to the {} catalog, not the {scope} catalog.",
                        profile["scope"].as_str().unwrap_or("")
                    ),
                    format!(
                        "Select a {scope}-scoped profile with id \"{profile_id}\", or change the stage scope."
                    ),
                );
            }
            if let Some(error) = profile["error"].as_str().filter(|e| !e.is_empty()) {
                add(
                    format!("Agent profile \"{profile_id}\" is invalid: {error}"),
                    format!("Fix {}.", profile["profilePath"].as_str().unwrap_or("")),
                );
            }
            if require_trust && profile["trusted"] != true {
                add(
                    format!("Agent profile \"{profile_id}\" is not trusted."),
                    "Move the profile under the trusted profiles folder, or relax requireTrustedAgents.".into(),
                );
            }
        }
        if let Some(errors) = agent["errors"].as_array().filter(|e| !e.is_empty()) {
            let detail: Vec<String> = errors
                .iter()
                .map(|e| {
                    format!(
                        "{}: {}",
                        e["path"].as_str().unwrap_or(""),
                        e["message"].as_str().unwrap_or("")
                    )
                })
                .collect();
            add(
                format!(
                    "Agent \"{host_id}\" has a malformed manifest: {}",
                    detail.join("; ")
                ),
                format!("Fix {}.", agent["manifestPath"].as_str().unwrap_or("")),
            );
        }
        if require_trust && agent["trusted"] != true {
            add(
                format!("Agent \"{host_id}\" is not trusted."),
                "Move the agent under the trusted agents folder, or relax requireTrustedAgents in the workflow policy.".into(),
            );
        }
        for name in agent_ref["skillNames"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let Some(skill) = skills.iter().find(|s| s["metadata"]["name"] == name) else {
                add(
                    format!("Skill \"{name}\" is not discovered."),
                    format!("Install the \"{name}\" skill, or remove it from this stage."),
                );
                continue;
            };
            if let Some(error) = skill["error"].as_str().filter(|e| !e.is_empty()) {
                add(
                    format!("Skill \"{name}\" is invalid: {error}"),
                    format!("Fix {}.", skill["instructionsPath"].as_str().unwrap_or("")),
                );
                continue;
            }
            if skill["scope"].as_str().is_some_and(|s| s != scope) {
                add(
                    format!(
                        "Skill \"{name}\" belongs to the {} catalog, not the {scope} catalog.",
                        skill["scope"].as_str().unwrap_or("")
                    ),
                    format!("Select a {scope}-scoped skill, or change the stage scope."),
                );
                continue;
            }
            if require_trust && skill["trusted"] != true {
                add(
                    format!("Skill \"{name}\" is not trusted."),
                    "Move the skill under a trusted skills root, or relax requireTrustedAgents."
                        .into(),
                );
                continue;
            }
            if let Some(pinned) = agent_ref["skillFingerprints"][name].as_str() {
                if skill["fingerprint"].as_str().is_some_and(|f| f != pinned) {
                    add(
                        format!("Skill \"{name}\" has changed since this workflow pinned it."),
                        format!(
                            "Review {} and re-pin the fingerprint, or restore the previous version.",
                            skill["instructionsPath"].as_str().unwrap_or("")
                        ),
                    );
                }
            }
        }
        if node["mutatesWorktree"] != true && agent_ref["toolMode"] == "full" {
            add(
                format!(
                    "Stage \"{}\" is non-mutating but requests full tool mode.",
                    node["id"].as_str().unwrap_or("")
                ),
                "Set the stage to read-only or project-only, or mark it as mutating.".into(),
            );
        }
    }
    blockers
}

pub fn stored_run(host: &HostContext, run_id: &str) -> Option<WorkflowRun> {
    get_runs(host).into_iter().find(|r| r.run_id == run_id)
}

fn require_run(host: &HostContext, run_id: &str) -> Result<WorkflowRun> {
    stored_run(host, run_id).ok_or_else(|| failure(format!("Run {run_id} was not found.")))
}

/// Persists one run record (initial records and engine transitions alike) and announces it.
pub fn save_run_record(host: &HostContext, run: WorkflowRun) -> Result<WorkflowRun> {
    let _guard = workflow_engine::runs_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    save_single_run(host, run)
}

/// Applies `change` to the latest record through the orchestrator's per-run chain.
/// A refusal from `change` leaves the run untouched and is returned to the caller.
fn with_run<F>(host: &HostContext, run_id: &str, change: F) -> Result<WorkflowRun>
where
    F: FnOnce(&WorkflowRun) -> std::result::Result<WorkflowRun, String> + Send + 'static,
{
    require_run(host, run_id)?;
    let refusal: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&refusal);
    runtime::block_on(workflow_engine::engine(host).orchestrator().update_run(
        run_id,
        move |run| match change(&run) {
            Ok(next) => next,
            Err(reason) => {
                *slot
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(reason);
                run
            }
        },
    ))
    .map_err(failure)?;
    if let Some(reason) = refusal
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
    {
        return Err(failure(reason));
    }
    require_run(host, run_id)
}

fn step(host: &HostContext, run_id: &str) {
    let orchestrator = workflow_engine::engine(host).orchestrator().clone();
    runtime::block_on(async move { orchestrator.step(run_id).await });
}

fn step_and_summarize(host: &HostContext, run_id: &str) -> Result<Value> {
    step(host, run_id);
    Ok(summarize(host, &require_run(host, run_id)?))
}

/// Everything `startWorkflowRun` takes beyond the project and workflow.
#[derive(Default)]
pub struct StartRunInput {
    pub project_id: String,
    pub workflow_id: String,
    pub task_title: String,
    pub issue_key: Option<String>,
    pub issue_connection_id: Option<String>,
    pub controller_session_key: Option<String>,
    pub controller_session_id: Option<String>,
    pub plan_input: Option<Value>,
    pub scheduled_launch_token: Option<String>,
    pub options: Value,
}

fn string_option(options: &Value, key: &str) -> Option<String> {
    options
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A project workflow by id, or the template it would be instantiated from, without saving it.
pub fn runnable_definition(
    host: &HostContext,
    project_id: &str,
    workflow_id: &str,
) -> Option<Value> {
    if let Some(own) = project_definition_values(host, project_id)
        .into_iter()
        .find(|d| d.get("id").and_then(Value::as_str) == Some(workflow_id))
    {
        return Some(own);
    }
    all_template_values(host, project_id)
        .into_iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(workflow_id))
        .map(|t| instantiate_template(&t, project_id, &now(), Some(workflow_id), None))
}

pub fn start_workflow_run(host: &HostContext, input: StartRunInput) -> Result<WorkflowRun> {
    let StartRunInput {
        project_id,
        workflow_id,
        task_title,
        issue_key,
        issue_connection_id,
        controller_session_key,
        controller_session_id,
        plan_input,
        scheduled_launch_token,
        options,
    } = input;

    let own = project_definition_values(host, &project_id)
        .into_iter()
        .find(|d| d.get("id").and_then(Value::as_str) == Some(workflow_id.as_str()));
    let instantiated = own.is_none();
    let definition = match own {
        Some(own) => own,
        None => runnable_definition(host, &project_id, &workflow_id).ok_or_else(|| {
            failure(format!(
                "Workflow {workflow_id} was not found for this project."
            ))
        })?,
    };
    let name = definition["name"].as_str().unwrap_or("").to_string();
    if definition["trigger"] == "ticket"
        && issue_key.as_deref().map(str::trim).unwrap_or("").is_empty()
    {
        return Err(failure(format!(
            "The ticket-owned workflow \"{name}\" must be started from a ticket."
        )));
    }

    let trust = project_workflow_trust(host, &project_id, &workflow_id, Some(&definition), false);
    if !trust.trusted {
        return Err(failure(
            "This project workflow needs local workspace trust. Review its commands and approve it on the desktop before starting it.",
        ));
    }
    if instantiated {
        persist_project_workflow(host, &project_id, &definition)?;
        let created =
            project_workflow_trust(host, &project_id, &workflow_id, Some(&definition), false);
        if !created.key.is_empty() {
            set_trust(host, &created.key, &created.fingerprint)?;
        }
    }

    let policy = policy_value_for(host, &project_id);
    let validation = validate_workflow(&definition, policy.as_ref());
    if !validation.valid() {
        let detail: Vec<String> = validation
            .errors
            .iter()
            .map(|e| e.message.clone())
            .collect();
        return Err(failure(format!(
            "Cannot start an invalid workflow: {}",
            detail.join("; ")
        )));
    }
    let typed: WorkflowDefinition = serde_json::from_value(definition.clone()).map_err(failure)?;
    // A run started from a template needs the agents and skills it names, as instantiating one installs them.
    if instantiated {
        ensure_workflow_dependencies_installed(host, &definition);
    }

    let has_agent_stage = typed
        .nodes
        .iter()
        .any(|n| matches!(n, WorkflowNode::AgentTask(_)));
    if has_agent_stage {
        let nodes = definition["nodes"].as_array().cloned().unwrap_or_default();
        let blockers = preflight_blockers(&agent_catalog(host), &nodes, policy.as_ref());
        if !blockers.is_empty() {
            return Err(failure(format!(
                "Cannot start workflow until its Agent Hub bindings are ready: {}",
                blockers.join(" ")
            )));
        }
    }

    // A check stage's tool that is not installed would otherwise surface only when the run
    // reaches that stage, after the agent stages have spent their time.
    if let Some(message) = workflow_engine::missing_check_tools_message(&typed.nodes) {
        return Err(failure(message));
    }

    let uncommitted = match options.get("uncommittedChanges").and_then(Value::as_str) {
        Some(v @ ("include" | "omit")) => Some(v.to_string()),
        _ => None,
    };
    if uncommitted.is_none() {
        assert_run_base_ready(host, &project_id)?;
    }

    let supplied = options.get("parameters").filter(|p| p.is_object());
    let parameters = resolve_run_parameters(&definition, supplied)?;

    let mut create = json!({
        "runId": uuid::Uuid::new_v4().to_string(),
        "projectId": project_id,
        "definition": {},
        "at": now(),
    });
    let mut run_definition = definition.clone();
    run_definition["name"] = json!(format!("{name} — {task_title}").trim());
    create["definition"] = run_definition;
    if let Some(key) = issue_key.filter(|k| !k.trim().is_empty()) {
        create["issueKey"] = json!(key);
        if let Some(c) = issue_connection_id {
            create["issueConnectionId"] = json!(c);
        }
    }
    if let Some(token) = scheduled_launch_token {
        create["scheduledLaunchToken"] = json!(token);
    }
    if let Some(branch) = string_option(&options, "sharedDeliveryBranch") {
        create["sharedDeliveryBranch"] = json!(branch);
    }
    if options.get("deferMerge") == Some(&json!(true)) {
        create["deferMerge"] = json!(true);
    }
    if let (Some(key), Some(id)) = (controller_session_key, controller_session_id) {
        create["controllerSessionKey"] = json!(key);
        create["controllerSessionId"] = json!(id);
    }
    if let Some(plan) = plan_input.filter(|p| !p.is_null()) {
        create["planInput"] = plan;
    }
    if options.get("permissionMode") == Some(&json!("auto")) {
        create["permissionMode"] = json!("auto");
    }
    if let Some(u) = &uncommitted {
        create["uncommittedChanges"] = json!(u);
    }
    if let Some(p) = string_option(&options, "aiProvider") {
        create["aiProvider"] = json!(p);
    }
    if let Some(m) = string_option(&options, "aiModel") {
        create["aiModel"] = json!(m);
    }
    if let Some(p @ ("switch" | "stop")) =
        options.get("providerLimitPolicy").and_then(Value::as_str)
    {
        create["providerLimitPolicy"] = json!(p);
    }
    if !parameters.as_object().is_none_or(serde_json::Map::is_empty) {
        create["parameters"] = parameters;
    }
    let input: CreateWorkflowRunInput = serde_json::from_value(create).map_err(failure)?;
    let run = create_workflow_run(input);

    // App-authored definitions and selected templates have no repository trust gate, but still
    // record their snapshot grant so removing a file cannot bypass recovery.
    if trust.key.is_empty() {
        let snapshot =
            project_workflow_trust(host, &project_id, &workflow_id, Some(&definition), true);
        if !snapshot.key.is_empty() {
            set_trust(host, &snapshot.key, &snapshot.fingerprint)?;
        }
    }
    let saved = save_run_record(host, run)?;
    // The session that started the run is its controller: it lists the run and follows it.
    if let (Some(key), Some(_)) = (&saved.controller_session_key, &saved.controller_session_id) {
        let (run_id, workflow_id, version) = (
            saved.run_id.clone(),
            saved.workflow_id.clone(),
            saved.workflow_version,
        );
        let _ =
            super::session_store::store(&host.config().user_data_dir).mutate(key, true, |record| {
                let mut ids: Vec<Value> = record["workflowRunIds"]
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| {
                        record["workflowRunId"]
                            .as_str()
                            .filter(|r| !r.is_empty())
                            .map(|r| vec![json!(r)])
                            .unwrap_or_default()
                    });
                ids.push(json!(run_id));
                record["workflowRunId"] = json!(run_id);
                record["workflowRunIds"] = json!(ids);
                record["workflowNodeId"] = json!("");
                record["workflowId"] = json!(workflow_id);
                record["workflowVersion"] = json!(version);
                record["workflowRole"] = json!("controller");
            });
    }
    workflow_engine::step_in_background(host, &saved.run_id);
    Ok(saved)
}

/// The run's parameter values: defaults for what is not supplied, supplied values checked.
fn resolve_run_parameters(definition: &Value, supplied: Option<&Value>) -> Result<Value> {
    let mut values = serde_json::Map::new();
    let mut problems = Vec::new();
    for parameter in definition
        .get("parameters")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let id = parameter["id"].as_str().unwrap_or("");
        let label = parameter["label"].as_str().unwrap_or(id);
        let kind = parameter["kind"].as_str().unwrap_or("text");
        let given = supplied.and_then(|s| s.get(id)).filter(|v| !v.is_null());
        let raw = given.or_else(|| parameter.get("default").filter(|v| !v.is_null()));
        let Some(raw) = raw else {
            if parameter["required"] == json!(true) {
                problems.push(format!("{label} is required."));
            }
            continue;
        };
        match kind {
            "text" => {
                let text = raw.as_str().map_or_else(|| raw.to_string(), str::to_string);
                if text.trim().is_empty() {
                    if parameter["required"] == json!(true) {
                        problems.push(format!("{label} is required."));
                    }
                    continue;
                }
                values.insert(id.to_string(), json!(text.trim()));
            }
            _ => {
                let number = raw
                    .as_f64()
                    .or_else(|| raw.as_str().and_then(|s| s.trim().parse::<f64>().ok()));
                let Some(number) = number else {
                    problems.push(format!("{label} must be a number."));
                    continue;
                };
                if kind == "integer" && number.fract() != 0.0 {
                    problems.push(format!("{label} must be a whole number."));
                    continue;
                }
                if parameter["min"].as_f64().is_some_and(|m| number < m) {
                    problems.push(format!("{label} must be at least {}.", parameter["min"]));
                    continue;
                }
                if parameter["max"].as_f64().is_some_and(|m| number > m) {
                    problems.push(format!("{label} must be at most {}.", parameter["max"]));
                    continue;
                }
                values.insert(
                    id.to_string(),
                    if kind == "integer" {
                        json!(number as i64)
                    } else {
                        json!(number)
                    },
                );
            }
        }
    }
    if problems.is_empty() {
        Ok(Value::Object(values))
    } else {
        Err(failure(problems.join(" ")))
    }
}

pub fn start_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let issue = args.get(3).filter(|v| v.is_object());
    let controller = args.get(4).filter(|v| v.is_object());
    let run = start_workflow_run(
        host,
        StartRunInput {
            project_id: text(args, 0)?.to_string(),
            workflow_id: text(args, 1)?.to_string(),
            task_title: args
                .get(2)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            issue_key: issue.and_then(|i| i["issueKey"].as_str().map(str::to_string)),
            issue_connection_id: issue.and_then(|i| i["connectionId"].as_str().map(str::to_string)),
            controller_session_key: controller
                .and_then(|c| c["sessionKey"].as_str().map(str::to_string)),
            controller_session_id: controller
                .and_then(|c| c["sessionId"].as_str().map(str::to_string)),
            plan_input: args.get(5).cloned(),
            scheduled_launch_token: None,
            options: args.get(6).cloned().unwrap_or(Value::Null),
        },
    )?;
    Ok(summarize(host, &run))
}

pub fn prepare_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let workflow_id = text(args, 1)?;
    let supplied = args.get(2).filter(|v| v.is_object());
    let definition = runnable_definition(host, project_id, workflow_id).ok_or_else(|| {
        failure(format!(
            "Workflow {workflow_id} was not found for this project."
        ))
    })?;
    let resolved = resolve_run_parameters(&definition, supplied);
    let (values, issues) = match resolved {
        Ok(values) => (values, Vec::new()),
        Err(error) => (
            json!({}),
            if supplied.is_some() {
                vec![json!({ "message": error.message })]
            } else {
                Vec::new()
            },
        ),
    };
    let settings = host.settings().read();
    let active = settings.ai.active_provider.clone();
    let threshold = u64::from(settings.delivery.run_confirm_agent_sessions);
    let tiers = settings.ai.model_tiers.clone();
    drop(settings);
    let provider_for = |node: &Value| {
        node["agent"]["providerId"]
            .as_str()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .or_else(|| Some(active.clone()).filter(|a| !a.is_empty()))
    };
    let tier_model = |provider: Option<&str>, tier: Option<&str>| {
        let config = tiers.as_ref()?.get(provider?)?;
        let model = match tier? {
            "fast" => config.fast.as_ref(),
            "standard" => config.standard.as_ref(),
            "strong" => config.strong.as_ref(),
            _ => None,
        }?;
        Some(model.trim().to_string()).filter(|m| !m.is_empty())
    };
    let estimate = super::workflow_estimate::estimate_workflow_run(
        &definition,
        &values,
        threshold,
        &provider_for,
        &tier_model,
    );
    Ok(json!({
        "parameters": definition.get("parameters").cloned().unwrap_or_else(|| json!([])),
        "requiresMeasurableGoal": definition["requiresMeasurableGoal"] == json!(true),
        "estimate": estimate,
        "issues": issues,
    }))
}

pub fn blocking_files(host: &HostContext, project_id: &str) -> Result<Vec<String>> {
    let Some(folder) = project_folder(host, project_id) else {
        return Ok(Vec::new());
    };
    match runtime::block_on(workflow_engine::base_blocking_paths(&folder)) {
        Ok(files) => Ok(files),
        Err(detail) if detail.to_lowercase().contains("not a git repository") => {
            let project_name =
                Catalog::load_readonly(&host.config().user_data_dir, &host.config().settings_path)
                    .ok()
                    .and_then(|c| c.require(storage::PROJECTS, project_id).ok())
                    .and_then(|p| p["name"].as_str().map(str::to_string))
                    .unwrap_or_else(|| "This project".to_string());
            Err(failure(format!(
                "{project_name}'s workspace folder isn't a Git repository yet ({}). A workflow run builds an isolated copy of the project from Git history, so initialize Git there or attach a different workspace folder before starting a run.",
                folder.display()
            )))
        }
        Err(detail) => Err(failure(detail)),
    }
}

fn assert_run_base_ready(host: &HostContext, project_id: &str) -> Result<()> {
    let blocking = blocking_files(host, project_id)?;
    if blocking.is_empty() {
        return Ok(());
    }
    let examples = blocking
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let more = if blocking.len() > 3 { ", …" } else { "" };
    let one = blocking.len() == 1;
    Err(failure(format!(
        "{} uncommitted {} in this project {} not in the last commit{}, and a workflow run works from a copy of that commit. Commit or stash them and try again, or choose to include them or start without them.",
        blocking.len(),
        if one { "file" } else { "files" },
        if one { "is" } else { "are" },
        if examples.is_empty() {
            String::new()
        } else {
            format!(" ({examples}{more})")
        },
    )))
}

pub fn check_run_base(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    Ok(json!({ "blockingFiles": blocking_files(host, project_id)? }))
}

pub fn commit_run_base(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let message = text(args, 1)?;
    let Some(folder) = project_folder(host, project_id) else {
        return Ok(Value::Null);
    };
    let files = blocking_files(host, project_id)?;
    if files.is_empty() {
        return Ok(Value::Null);
    }
    runtime::block_on(workflow_engine::commit_paths(&folder, &files, message)).map_err(failure)?;
    Ok(Value::Null)
}

pub fn select_controller_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let session_key = text(args, 0)?;
    let run_id = text(args, 1)?;
    let run = stored_run(host, run_id)
        .filter(|r| r.controller_session_key.as_deref() == Some(session_key))
        .ok_or_else(|| failure("That workflow run is not controlled by this session."))?;
    Ok(summarize(host, &run))
}

pub fn remove_controller_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let session_key = text(args, 0)?;
    let run_id = text(args, 1)?;
    let reason = args.get(2).and_then(Value::as_str);
    if let Some(run) = stored_run(host, run_id) {
        if run.controller_session_key.as_deref() != Some(session_key) {
            return Err(failure(
                "That workflow run is not controlled by this session.",
            ));
        }
        if !is_run_settled(&run) {
            runtime::block_on(
                workflow_engine::engine(host)
                    .orchestrator()
                    .cancel(run_id, Some(reason.unwrap_or("Removed from the session."))),
            )
            .map_err(failure)?;
        }
    }
    Ok(Value::Null)
}

pub fn list_runs(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let policy = policy_for(host, project_id);
    let summaries: Vec<Value> = get_runs(host)
        .into_iter()
        .filter(|r| r.project_id == project_id)
        .map(|r| summarize_workflow_run(&r, policy.as_ref()))
        .collect();
    Ok(json!(summaries))
}

pub fn get_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    Ok(stored_run(host, run_id).map_or(Value::Null, |r| summarize(host, &r)))
}

pub fn rename_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let name = args
        .get(1)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return Err(failure("Automation name cannot be empty."));
    }
    if name.chars().count() > 120 {
        return Err(failure("Automation name must be 120 characters or fewer."));
    }
    let run = with_run(host, run_id, move |run| {
        let mut next = run.clone();
        next.display_name = if name == next.definition.name {
            None
        } else {
            Some(name)
        };
        Ok(next)
    })?;
    Ok(summarize(host, &run))
}

pub fn advance_stage(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?.to_string();
    let outcome = text(args, 2)?.to_string();
    let detail = args.get(3).cloned().unwrap_or(Value::Null);
    with_run(host, run_id, move |run| {
        let at = now();
        let started = WorkflowRunCommand::NodeStarted {
            node_id: node_id.clone(),
            at: at.clone(),
            session_id: Some(format!("manual-{node_id}")),
        };
        let mut next = apply_workflow_run_command(run, &started).unwrap_or_else(|| run.clone());
        let node = next
            .definition
            .nodes
            .iter()
            .find(|n| n.base().id == node_id)
            .cloned();
        let outputs = match &node {
            Some(WorkflowNode::AgentTask(n)) => n.outputs.clone(),
            Some(WorkflowNode::Check(n)) => n.outputs.clone(),
            Some(WorkflowNode::Deployment(n)) => n.outputs.clone(),
            _ => Vec::new(),
        };
        let supplied_findings: Option<CheckFindings> = detail
            .get("findings")
            .filter(|f| f.get("findings").is_some_and(Value::is_array))
            .and_then(|f| serde_json::from_value(f.clone()).ok());
        let command = if outcome == "succeeded" {
            let findings = supplied_findings.or_else(|| {
                outputs
                    .iter()
                    .any(|c| c.kind == WorkflowArtifactKind::Findings)
                    .then(CheckFindings::default)
            });
            WorkflowRunCommand::NodeSucceeded {
                node_id: node_id.clone(),
                at: at.clone(),
                artifacts: Some(
                    outputs
                        .iter()
                        .map(|c| DeclaredArtifact {
                            contract_id: c.id.clone(),
                            kind: c.kind,
                            path: None,
                            artifact_id: None,
                            reference: None,
                        })
                        .collect(),
                ),
                exit_code: None,
                snapshot_ref: detail["snapshotRef"].as_str().map(str::to_string),
                assessed_snapshot_ref: None,
                findings,
                provider: None,
                model: None,
                independence: None,
                map_items: None,
            }
        } else {
            WorkflowRunCommand::NodeFailed {
                node_id: node_id.clone(),
                at: at.clone(),
                error: detail["error"]
                    .as_str()
                    .unwrap_or("Stage failed.")
                    .to_string(),
                exit_code: None,
                findings: supplied_findings,
                pause: None,
                provider: None,
                model: None,
                independence: None,
                map_items: None,
                conflict_files: None,
            }
        };
        next = apply_workflow_run_command(&next, &command).unwrap_or(next);
        Ok(advance_joins(next, &at))
    })?;
    step_and_summarize(host, run_id)
}

pub fn approve_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let actor = text(args, 1)?.to_string();
    let node_id = args.get(3).and_then(Value::as_str).map(str::to_string);
    let run_for_policy = require_run(host, run_id)?;
    let policy = policy_for(host, &run_for_policy.project_id);
    with_run(host, run_id, move |run| {
        let approval = resolve_approval_target(run, node_id.as_deref())?;
        let result = approve_stage(
            run,
            &approval.base.id,
            &actor,
            &now(),
            policy.as_ref(),
            None,
        )?;
        if !result.ok {
            return Err(result
                .reason
                .unwrap_or_else(|| "Approval was refused.".into()));
        }
        Ok(result.run)
    })?;
    step_and_summarize(host, run_id)
}

pub fn bypass_gate_cmd(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let gate_str = text(args, 1)?.to_string();
    let actor = text(args, 2)?.to_string();
    let reason = text(args, 3)?.to_string();
    let node_id = args.get(4).and_then(Value::as_str).map(str::to_string);
    let run_for_policy = require_run(host, run_id)?;
    let policy = policy_for(host, &run_for_policy.project_id);
    with_run(host, run_id, move |run| {
        let approval = resolve_approval_target(run, node_id.as_deref())?;
        let gate = match gate_str.as_str() {
            "security" => WorkflowGateKind::Security,
            "qa" => WorkflowGateKind::Qa,
            _ => WorkflowGateKind::Review,
        };
        let input = GateBypassInput {
            gate,
            actor,
            reason,
            at: now(),
        };
        let result = bypass_gate(run, &approval.base.id, &input, policy.as_ref(), None)?;
        if !result.ok {
            return Err(result
                .reason
                .unwrap_or_else(|| "The bypass was refused.".into()));
        }
        Ok(result.run)
    })?;
    step_and_summarize(host, run_id)
}

pub fn skip_approval(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?.to_string();
    let actor = text(args, 2)?.to_string();
    with_run(host, run_id, move |run| {
        let result = gates_skip_approval(run, &node_id, &actor, &now())?;
        if !result.ok {
            return Err(result
                .reason
                .unwrap_or_else(|| "The approval could not be skipped.".into()));
        }
        Ok(result.run)
    })?;
    step_and_summarize(host, run_id)
}

pub fn decide_loop(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let edge_id = text(args, 1)?.to_string();
    let actor = args
        .get(2)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let decision_str = text(args, 3)?.to_string();
    let reason = args
        .get(4)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let extra = args.get(5).and_then(Value::as_f64);

    let decision = match decision_str.as_str() {
        "accept" => LoopDecisionKind::Accept,
        "grant" => LoopDecisionKind::Grant,
        "stop" => LoopDecisionKind::Stop,
        _ => return Err(failure("Choose accept, grant or stop.")),
    };
    if actor.trim().is_empty() {
        return Err(failure("A loop decision must record who made it."));
    }
    if matches!(decision_str.as_str(), "accept" | "stop") && reason.is_none() {
        return Err(failure(if decision_str == "accept" {
            "Say why the result is acceptable as it is."
        } else {
            "Say why the run should stop."
        }));
    }
    with_run(host, run_id, move |run| {
        let command = WorkflowRunCommand::LoopDecided {
            edge_id,
            at: now(),
            actor,
            decision,
            reason,
            extra_iterations: extra,
        };
        match apply_workflow_run_command(run, &command) {
            Some(next) if next != *run => Ok(next),
            _ => Err(if decision_str == "grant" {
                "No more iterations can be granted: the loop is at its ceiling, or it is not waiting for a decision.".to_string()
            } else {
                "That loop is not waiting for a decision.".to_string()
            }),
        }
    })?;
    step_and_summarize(host, run_id)
}

/// A report or plan stage's written output: its session's final response.
fn stage_report_text(host: &HostContext, run_id: &str, node_id: &str) -> Option<String> {
    let run = stored_run(host, run_id)?;
    run.nodes.get(node_id)?;
    let key = workflow_summary::stage_session_key(run_id, node_id);
    let record = super::session_store::store(&host.config().user_data_dir)
        .get(&key)
        .ok()
        .flatten()?;
    let response = record["responseText"].as_str()?;
    let stripped = regex::Regex::new(r"```praxis-plan[^\n]*\n[\s\S]*?```")
        .ok()?
        .replace_all(response, "")
        .trim()
        .to_string();
    (!stripped.is_empty()).then_some(stripped)
}

pub fn stage_report(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?;
    Ok(stage_report_text(host, run_id, node_id).map_or(Value::Null, Value::from))
}

pub fn save_stage_report(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?;
    if stage_report_text(host, run_id, node_id).is_none() {
        return Err(failure("This stage has no written output to save."));
    }
    // The save dialog belongs to a native window; without one nothing is written.
    Ok(json!({ "saved": false }))
}

pub fn retry_stage(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?.to_string();
    with_run(host, run_id, move |run| {
        Ok(
            apply_workflow_run_command(run, &WorkflowRunCommand::NodeRetry { node_id, at: now() })
                .unwrap_or_else(|| run.clone()),
        )
    })?;
    step_and_summarize(host, run_id)
}

pub fn switch_stage_provider(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?.to_string();
    let provider = text(args, 2)?.to_string();
    let model = args.get(3).and_then(Value::as_str).map(str::to_string);
    with_run(host, run_id, move |run| {
        Ok(apply_workflow_run_command(
            run,
            &WorkflowRunCommand::StageProviderSwitched {
                node_id,
                at: now(),
                provider,
                model,
                automatic: None,
            },
        )
        .unwrap_or_else(|| run.clone()))
    })?;
    step_and_summarize(host, run_id)
}

pub fn stop_for_provider_limit(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?.to_string();
    with_run(host, run_id, move |run| {
        Ok(apply_workflow_run_command(
            run,
            &WorkflowRunCommand::ProviderLimitStop {
                node_id,
                at: now(),
                detail: None,
            },
        )
        .unwrap_or_else(|| run.clone()))
    })?;
    step_and_summarize(host, run_id)
}

pub fn rework_stage(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?.to_string();
    let policy = policy_for(host, &require_run(host, run_id)?.project_id);
    with_run(host, run_id, move |run| {
        let options = ReworkOptions {
            by_person: true,
            carry_findings: failing_gate_findings(run, policy.as_ref(), None),
            ..Default::default()
        };
        let result = rework_workflow_run(run, &node_id, &now(), &options);
        match result.reason {
            Some(reason) => Err(reason),
            None => Ok(result.run),
        }
    })?;
    step_and_summarize(host, run_id)
}

pub fn resolve_merge_with_ai(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?.to_string();
    with_run(host, run_id, move |run| {
        allow_ai_merge_resolution(run, &node_id, &now())
            .ok_or_else(|| "This merge is not stopped on a conflict.".to_string())
    })?;
    step_and_summarize(host, run_id)
}

pub fn cancel_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let reason = args.get(1).and_then(Value::as_str);
    require_run(host, run_id)?;
    runtime::block_on(
        workflow_engine::engine(host)
            .orchestrator()
            .cancel(run_id, reason),
    )
    .map_err(failure)?;
    Ok(summarize(host, &require_run(host, run_id)?))
}

pub fn inspect_run_work(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let run = require_run(host, run_id)?;
    let empty = json!({ "commitCount": 0, "commits": [], "uncommittedFiles": 0, "hasWork": false });
    let Some(folder) = project_folder(host, &run.project_id) else {
        return Ok(empty);
    };
    let Some(root) = runtime::block_on(repository_root(&folder)) else {
        return Ok(empty);
    };
    let worktree = run.worktree_path.as_deref().map(PathBuf::from);
    let info = runtime::block_on(praxis_core::git::run_work::inspect_run_work(
        Path::new(&root),
        &run.run_id,
        worktree.as_deref(),
    ));
    serde_json::to_value(info).map_err(failure)
}

pub fn delete_run(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let delete_work = args
        .get(1)
        .and_then(|o| o.get("deleteWork"))
        .and_then(Value::as_bool)
        == Some(true);
    let run = require_run(host, run_id)?;
    if !is_run_settled(&run) {
        runtime::block_on(
            workflow_engine::engine(host)
                .orchestrator()
                .cancel(run_id, Some("Deleted by the user.")),
        )
        .map_err(failure)?;
    }
    if delete_work {
        if let Some(folder) = project_folder(host, &run.project_id) {
            if let Some(root) = runtime::block_on(repository_root(&folder)) {
                let worktree = stored_run(host, run_id)
                    .and_then(|r| r.worktree_path)
                    .or(run.worktree_path.clone())
                    .map(PathBuf::from);
                runtime::block_on(praxis_core::git::run_work::delete_run_work(
                    Path::new(&root),
                    &run.run_id,
                    worktree.as_deref(),
                ))
                .map_err(failure)?;
            }
        }
    }
    // The run's stage sessions (their transcripts belong to the run) and its link from the
    // controller session that started it go with it.
    let sessions = super::session_store::store(&host.config().user_data_dir);
    for node in &run.definition.nodes {
        let key = workflow_summary::stage_session_key(run_id, node.id());
        if sessions.get(&key).ok().flatten().is_some() {
            let _ = sessions.remove(&key);
            host.events().emit("ai:sessionDeleted", Some(json!(key)));
        }
    }
    if let Some(controller) = run.controller_session_key.as_deref() {
        let remaining: Vec<String> = sessions
            .get(controller)
            .ok()
            .flatten()
            .map(|record| {
                record["workflowRunIds"]
                    .as_array()
                    .map(|ids| {
                        ids.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_else(|| {
                        record["workflowRunId"]
                            .as_str()
                            .filter(|r| !r.is_empty())
                            .map(|r| vec![r.to_string()])
                            .unwrap_or_default()
                    })
            })
            .unwrap_or_default()
            .into_iter()
            .filter(|id| id != run_id)
            .collect();
        let next = remaining.last().and_then(|id| stored_run(host, id));
        let updated = sessions.mutate(controller, true, |record| {
            record["workflowRunId"] = json!(remaining.last().cloned().unwrap_or_default());
            record["workflowRunIds"] = json!(remaining);
            record["workflowNodeId"] = json!("");
            record["workflowId"] = json!(
                next.as_ref()
                    .map(|r| r.workflow_id.clone())
                    .unwrap_or_default()
            );
            if let Some(next) = &next {
                record["workflowVersion"] = json!(next.workflow_version);
                record["workflowRole"] = json!("controller");
            }
        });
        if let Ok(Some(record)) = updated {
            host.events().emit("ai:sessionChanged", Some(record));
        }
    }
    let _guard = workflow_engine::runs_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let next: Vec<_> = get_runs(host)
        .into_iter()
        .filter(|r| r.run_id != run_id)
        .collect();
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
    let run = with_run(host, run_id, move |run| {
        let mut next = run.clone();
        next.archived = archived.then_some(true);
        next.archived_at = archived.then(now);
        Ok(next)
    })?;
    Ok(summarize(host, &run))
}

pub fn get_evidence(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?;
    let attempt = args.get(2).and_then(Value::as_u64).unwrap_or(1) as usize;
    let Some(run) = stored_run(host, run_id) else {
        return Ok(json!({ "expired": false }));
    };
    Ok(super::workflow_evidence::read_view(
        &host.config().user_data_dir.join("workflow-evidence"),
        &super::workflow_evidence::EvidenceKey {
            project_id: &run.project_id,
            run_id,
            node_id,
            attempt,
        },
        &run.project_id,
    ))
}

/// `workflows:startDiagnosis`: opens a session on the retained evidence of one check attempt, or
/// returns `{ ok: false, reason, message }` saying why it cannot.
pub fn start_diagnosis(host: &HostContext, args: &[Value]) -> Result<Value> {
    let run_id = text(args, 0)?;
    let node_id = text(args, 1)?;
    let attempt = args.get(2).and_then(Value::as_u64).unwrap_or(1) as usize;
    let refuse =
        |message: String| Ok(json!({ "ok": false, "reason": "no-evidence", "message": message }));
    let Some(run) = stored_run(host, run_id) else {
        return refuse(format!("Run {run_id} was not found."));
    };
    if !run
        .definition
        .nodes
        .iter()
        .any(|n| n.base().id == node_id && matches!(n, WorkflowNode::Check(_)))
    {
        return refuse(format!("Stage {node_id} is not a check stage."));
    }
    let project =
        Catalog::load_readonly(&host.config().user_data_dir, &host.config().settings_path)
            .ok()
            .and_then(|catalog| catalog.require(storage::PROJECTS, &run.project_id).ok());
    let folder = project
        .as_ref()
        .and_then(|p| p["workspaceFolder"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let tool_mode = project
        .as_ref()
        .and_then(|p| p["defaultAiToolMode"].as_str())
        .unwrap_or("full")
        .to_string();
    let run_for_task = run.clone();
    let host_for_task = host.clone();
    let node_id = node_id.to_string();
    Ok(runtime::block_on(async move {
        let mut working_directory = folder.clone();
        if let Some(worktree) = run_for_task
            .worktree_path
            .as_deref()
            .filter(|w| Path::new(w).exists())
        {
            working_directory = Some(worktree.to_string());
        } else if folder.is_some() {
            // Fall back to the project folder when the worktree cannot be re-acquired.
            if let Some(acquired) =
                workflow_engine::reacquire_worktree(&host_for_task, &run_for_task).await
            {
                working_directory = Some(acquired);
            }
        }
        super::workflow_diagnosis::start_diagnosis_from_evidence(
            &host_for_task,
            &run_for_task,
            &node_id,
            attempt,
            working_directory,
            &tool_mode,
        )
        .await
    }))
}

const AGENT_SYSTEM_PROMPT: &str = "You are helping configure a stage in a governed software-delivery workflow.\nGiven the stage's name and instructions, and a list of trusted agents available to run it, pick the single\nbest-fitting agent for this specific stage. Respond with exactly one fenced JSON code block and nothing else:\n\n```json\n{ \"agentId\": \"<one of the listed agent ids, verbatim>\", \"rationale\": \"<one sentence, specific to this stage>\" }\n```";
const RECOMMENDATION_CACHE_FILE: &str = "workflow-agent-recommendations.json";
const RECOMMENDATION_CACHE_KEY: &str = "praxis.workflowAgentRecommendations.v1";

/// A digest of what would change the answer, so a stored recommendation can be flagged stale
/// without spending another call (`computeRecommendationFingerprint`).
pub fn recommendation_fingerprint(input: &Value) -> String {
    use sha2::{Digest, Sha256};
    let mut ids: Vec<&str> = input["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["agentId"].as_str())
        .collect();
    ids.sort_unstable();
    let payload = [
        input["stageName"].as_str().unwrap_or("").trim(),
        input["instructions"].as_str().unwrap_or("").trim(),
        &ids.join(","),
    ]
    .join(" ");
    Sha256::digest(payload.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn read_recommendation_cache(host: &HostContext) -> serde_json::Map<String, Value> {
    let path = host.config().user_data_dir.join(RECOMMENDATION_CACHE_FILE);
    let document = storage::read(&path)
        .ok()
        .flatten()
        .and_then(|raw| storage::parse(&path, Some(&raw)).ok())
        .unwrap_or(Value::Null);
    document[RECOMMENDATION_CACHE_KEY]
        .as_object()
        .cloned()
        .unwrap_or_default()
}

fn write_recommendation_cache(
    host: &HostContext,
    cache: serde_json::Map<String, Value>,
) -> Result<()> {
    let encoded = storage::encoded(&json!({ RECOMMENDATION_CACHE_KEY: cache }))?;
    storage::write_atomic(
        &host.config().user_data_dir.join(RECOMMENDATION_CACHE_FILE),
        &encoded,
        false,
    )
}

fn recommendation_key(args: &[Value]) -> Result<String> {
    Ok(format!("{}:{}", text(args, 0)?, text(args, 1)?))
}

/// The stored recommendation for a stage, and whether the stage changed since it was computed.
pub fn get_recommendation(host: &HostContext, args: &[Value]) -> Result<Value> {
    let key = recommendation_key(args)?;
    let Some(stored) = read_recommendation_cache(host).remove(&key) else {
        return Ok(json!({ "recommendation": null, "stale": false }));
    };
    let stale = stored["inputFingerprint"].as_str()
        != Some(recommendation_fingerprint(args.get(2).unwrap_or(&Value::Null)).as_str());
    Ok(json!({ "recommendation": stored, "stale": stale }))
}

pub fn clear_recommendation(host: &HostContext, args: &[Value]) -> Result<Value> {
    let key = recommendation_key(args)?;
    let mut cache = read_recommendation_cache(host);
    if cache.remove(&key).is_some() {
        write_recommendation_cache(host, cache)?;
    }
    Ok(Value::Null)
}

pub fn recommend_agent(host: &HostContext, args: &[Value]) -> Result<Value> {
    let key = recommendation_key(args)?;
    let input = args.get(2).cloned().unwrap_or(Value::Null);
    let candidates = input["candidates"].as_array().cloned().unwrap_or_default();
    if candidates.is_empty() {
        return Err(failure(
            "No trusted agents are available to recommend from.",
        ));
    }
    let catalog: Vec<String> = candidates
        .iter()
        .map(|c| {
            let skills: Vec<&str> = c["skills"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            format!(
                "- {}: {}{}",
                c["agentId"].as_str().unwrap_or(""),
                c["name"].as_str().unwrap_or(""),
                if skills.is_empty() {
                    String::new()
                } else {
                    format!(" (skills: {})", skills.join(", "))
                }
            )
        })
        .collect();
    let stage = input["stageName"]
        .as_str()
        .filter(|n| !n.is_empty())
        .unwrap_or("(untitled stage)");
    let instructions = input["instructions"]
        .as_str()
        .map(str::trim)
        .filter(|i| !i.is_empty())
        .unwrap_or("(none provided)");
    let prompt = format!(
        "Stage name: {stage}\nStage instructions:\n{instructions}\n\nTrusted agents available for this workflow:\n{}\n\nRecommend exactly one agent id from the list above.",
        catalog.join("\n")
    );
    let (connection, model) = recommendation_connection(host)?;
    let provider = connection.provider.clone();
    let (reply, usage) = runtime::block_on(super::api_host::run_provider_prompt(
        &connection,
        &model,
        AGENT_SYSTEM_PROMPT,
        &prompt,
        None,
        |_| {},
    ))
    .map_err(failure)?;
    let ids: Vec<String> = candidates
        .iter()
        .filter_map(|c| c["agentId"].as_str().map(str::to_owned))
        .collect();
    let (agent_id, rationale) = parse_choice(&reply, "agentId", &ids, "agents")?;
    let mut cache = read_recommendation_cache(host);
    cache.insert(key, json!({
        "agentId": agent_id, "rationale": rationale, "model": model, "provider": provider,
        "computedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true), "inputFingerprint": recommendation_fingerprint(&input),
    }));
    write_recommendation_cache(host, cache)?;
    Ok(
        json!({ "agentId": agent_id, "rationale": rationale, "model": model, "provider": provider, "usage": usage }),
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_ids_that_cannot_be_file_names_are_refused() {
        assert_eq!(
            workflow_file_name("governed-delivery-p1").unwrap(),
            "governed-delivery-p1.json"
        );
        assert!(workflow_file_name("").is_err());
        assert!(workflow_file_name("..").is_err());
        assert!(workflow_file_name(".hidden").is_err());
        assert!(workflow_file_name("a/b").is_err());
        assert!(workflow_file_name("has space").is_err());
    }

    #[test]
    fn run_parameters_default_validate_and_report_every_problem() {
        let definition = json!({
            "parameters": [
                { "id": "goal", "label": "Goal", "kind": "text", "required": true },
                { "id": "rounds", "label": "Rounds", "kind": "integer", "min": 1, "max": 5, "default": 3 }
            ]
        });
        let ok = resolve_run_parameters(&definition, Some(&json!({ "goal": " faster " }))).unwrap();
        assert_eq!(ok, json!({ "goal": "faster", "rounds": 3 }));
        let missing =
            resolve_run_parameters(&definition, Some(&json!({ "rounds": 9 }))).unwrap_err();
        assert!(missing.message.contains("Goal is required."));
        assert!(missing.message.contains("Rounds must be at most 5."));
    }

    #[test]
    fn preflight_names_a_missing_agent_with_what_to_do_about_it() {
        let nodes = vec![json!({
            "type": "agent-task", "id": "review", "mutatesWorktree": false,
            "agent": { "agentId": "ghost", "scope": "global", "toolMode": "read-only" }
        })];
        let catalog = json!({ "runtimeHosts": [], "profiles": [], "skills": [] });
        let blockers = preflight_blockers(&catalog, &nodes, None);
        assert_eq!(blockers.len(), 1);
        assert!(blockers[0].contains("Agent \"ghost\" is not in the global catalog."));
        assert!(blockers[0].contains("Install or import an agent with id \"ghost\""));
    }

    #[test]
    fn an_untrusted_agent_blocks_a_start_unless_policy_relaxes_it() {
        let nodes = vec![json!({
            "type": "agent-task", "id": "review", "mutatesWorktree": false,
            "agent": { "agentId": "a", "scope": "global", "toolMode": "read-only" }
        })];
        let catalog = json!({
            "runtimeHosts": [{ "manifest": { "id": "a" }, "scope": "global", "trusted": false, "errors": [] }],
            "profiles": [], "skills": []
        });
        assert!(
            preflight_blockers(&catalog, &nodes, None)
                .iter()
                .any(|b| b.contains("is not trusted"))
        );
        let relaxed = json!({ "requireTrustedAgents": false });
        assert!(preflight_blockers(&catalog, &nodes, Some(&relaxed)).is_empty());
    }

    #[test]
    fn a_template_copy_is_project_scoped_versioned_and_given_stage_tiers() {
        let template = json!({
            "id": "quick", "name": "Quick", "builtIn": true, "version": 7,
            "nodes": [
                { "type": "agent-task", "id": "impl", "mutatesWorktree": true },
                { "type": "agent-task", "id": "rev", "mutatesWorktree": false, "satisfiesGate": "qa" },
                { "type": "agent-task", "id": "note", "mutatesWorktree": false },
                { "type": "agent-task", "id": "kept", "modelTier": "fast" },
            ]
        });
        let copy = instantiate_template(&template, "p1", "2026-01-01T00:00:00.000Z", None, None);
        assert_eq!(copy["id"], "quick-p1");
        assert_eq!(copy["scope"], "project");
        assert_eq!(copy["version"], 1);
        assert!(copy.get("builtIn").is_none());
        let tiers: Vec<&str> = copy["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["modelTier"].as_str().unwrap())
            .collect();
        assert_eq!(tiers, ["strong", "standard", "fast", "fast"]);
    }

    #[test]
    fn recommendation_choices_must_be_an_offered_id() {
        let valid = vec!["a".to_owned(), "b".to_owned()];
        let ok = parse_choice(
            "```json\n{\"agentId\":\"b\",\"rationale\":\" fits \"}\n```",
            "agentId",
            &valid,
            "agents",
        )
        .unwrap();
        assert_eq!(ok, ("b".to_owned(), "fits".to_owned()));
        assert_eq!(
            parse_choice("{\"agentId\":\"a\"}", "agentId", &valid, "agents")
                .unwrap()
                .1,
            "No rationale was given."
        );
        assert!(
            parse_choice("{\"agentId\":\"z\"}", "agentId", &valid, "agents")
                .unwrap_err()
                .message
                .contains("not one of the offered agents")
        );
        assert!(
            parse_choice("nope", "agentId", &valid, "agents")
                .unwrap_err()
                .message
                .contains("not valid JSON")
        );
        assert!(
            parse_choice("{\"x\":1}", "agentId", &valid, "agents")
                .unwrap_err()
                .message
                .contains("did not include a agentId")
        );
    }

    #[test]
    fn the_fingerprint_changes_with_the_stage_but_not_candidate_order() {
        let input = |name: &str, ids: [&str; 2]| json!({ "stageName": name, "instructions": " do ", "candidates": [{"agentId": ids[0]}, {"agentId": ids[1]}] });
        assert_eq!(
            recommendation_fingerprint(&input("Build", ["a", "b"])),
            recommendation_fingerprint(&input(" Build ", ["b", "a"]))
        );
        assert_ne!(
            recommendation_fingerprint(&input("Build", ["a", "b"])),
            recommendation_fingerprint(&input("Test", ["a", "b"]))
        );
        assert_eq!(
            recommendation_fingerprint(&input("Build", ["a", "b"])).len(),
            64
        );
    }
}
