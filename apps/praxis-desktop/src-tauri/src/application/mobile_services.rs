//! What a paired phone reads and commands: the Rust port of `mobileHostComposition.ts`.
//!
//! `praxis_mobile::host::services` owns the protocol rules (field extraction, project scoping,
//! actor from the authenticated caller). This module supplies the narrow
//! [`MobileHostServiceDeps`] port from the desktop's own channels, so a phone reaches exactly the
//! sessions, runs, tickets and schedules the desktop window does, through the same code.
//!
//! The listener (`praxis_host::mobile_bridge`) forwards each decoded request in process as
//! `mobile:internal:read` / `mobile:internal:command`; [`register`] answers them.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use praxis_contracts::{RustRpcError, RustRpcRequest};
use praxis_core::git::git_graph::{GitDiffDocument, GitDiffRequest, GitStatusSnapshot};
use praxis_host::HostContext;
use praxis_mobile::host::application::{MobileHostApplication, MobileHostReads, default_payload_digest, handle_mobile_command};
use praxis_mobile::host::ledger::InMemoryMobileCommandLedger;
use praxis_mobile::host::permissions::{MobilePermissionAnswer, respond_to_mobile_permission};
use praxis_mobile::host::protocol::{MobileCommand, MobileReadRequest};
use praxis_mobile::host::run_projection::{MobileRunSummaryInput, mobile_run_snapshot};
use praxis_mobile::host::scheduled_runs::{
    MobileScheduleDeps, MobileScheduleStore, MobileSchedules, create_mobile_schedules,
};
use praxis_mobile::host::services::{
    MobileCreateSession, MobileDeviceRecord, MobileGadgetSubmitPayload, MobileHostServiceDeps,
    MobileImagePreviewParams, MobileModelCatalog, MobileModelOption, MobileProjectRef,
    MobileProjectSummary, MobileProviderCatalog, MobileProviderOption, MobileSessionModeOption,
    MobileSessionRuntimeChange, MobileStartRun, command_operations,
    create_mobile_host_execution_handlers, create_mobile_host_reads,
};
use praxis_mobile::host::session_changes::{
    MobileSessionChangesGit, read_mobile_session_changes, read_mobile_session_file_diff,
    MAX_MOBILE_DIFF_LINES,
};
use praxis_mobile::host::session_projection::{
    MobileSessionSnapshot, MobileSessionSummary, mobile_session_snapshot, mobile_session_summary,
};
use praxis_mobile::host::session_record::MobileSessionRecord;
use praxis_workflows::scheduled_run::{ScheduledRun, ScheduledTicketRef};
use serde_json::{Value, json};

use super::mobile_host::MobileHost;
use super::{failure, runtime};

type Fallible<T> = Result<T, String>;

/// One owner for the read and command tables, built when the first phone request arrives.
struct Tables {
    reads: MobileHostReads,
    /// Carries the command ledger: the listener forwards validated commands and leaves admission
    /// (replaying a retried command id instead of running it twice) to the trusted handlers.
    app: MobileHostApplication,
}

pub struct DesktopMobileDeps {
    host: HostContext,
    mobile: Arc<MobileHost>,
    epoch: String,
    /// Read from the identity before a request runs: resolving it blocks, which a request must not.
    host_id: Arc<OnceLock<String>>,
}

impl DesktopMobileDeps {
    pub fn new(host: &HostContext, mobile: &Arc<MobileHost>) -> Arc<Self> {
        Arc::new(Self { host: host.clone(), mobile: Arc::clone(mobile), epoch: uuid::Uuid::new_v4().to_string(), host_id: Arc::new(OnceLock::new()) })
    }

    /// Calls one of the desktop's own channels without holding up an async worker: several of them
    /// block on the profile lock or drive the app runtime themselves.
    async fn call(&self, channel: &str, args: Vec<Value>) -> Fallible<Value> {
        let host = self.host.clone();
        let channel = channel.to_owned();
        tokio::task::spawn_blocking(move || call_sync(&host, &channel, args))
            .await
            .map_err(|error| error.to_string())?
    }

    async fn sessions(&self, project_id: Option<&str>) -> Fallible<Vec<MobileSessionRecord>> {
        let listed = self.call("ai:listSessions", vec![]).await?;
        let mut records: Vec<MobileSessionRecord> = listed
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|value| serde_json::from_value(value.clone()).ok())
            .collect();
        let mut run_projects: HashMap<String, Option<String>> = HashMap::new();
        for record in &mut records {
            if record.project().is_none()
                && let Some(run_id) = record.workflow_run_id.clone().filter(|id| !id.is_empty())
            {
                // A workflow stage's session is started by its run, so it belongs to the run's project.
                if !run_projects.contains_key(&run_id) {
                    let project = self.call("workflows:getRun", vec![json!(run_id)]).await.ok().and_then(|run| run["projectId"].as_str().map(str::to_owned));
                    run_projects.insert(run_id.clone(), project);
                }
                record.project_id = run_projects.get(&run_id).cloned().flatten();
            }
        }
        records.retain(|record| project_id.is_none_or(|wanted| record.project() == Some(wanted)));
        Ok(records)
    }

    /// The whole record, events included (`ai:listSessions` leaves them out).
    async fn full_record(&self, key_or_id: &str) -> Fallible<Option<MobileSessionRecord>> {
        let value = self.call("ai:getSession", vec![json!(key_or_id)]).await?;
        if value.is_null() {
            return Ok(None);
        }
        let mut record: MobileSessionRecord = serde_json::from_value(value).map_err(|error| error.to_string())?;
        if record.project().is_none()
            && let Some(run_id) = record.workflow_run_id.clone().filter(|id| !id.is_empty())
        {
            record.project_id = self.call("workflows:getRun", vec![json!(run_id)]).await.ok().and_then(|run| run["projectId"].as_str().map(str::to_owned));
        }
        Ok(Some(record))
    }

    async fn require_record(&self, session_id: &str) -> Fallible<MobileSessionRecord> {
        self.full_record(session_id).await?.ok_or_else(|| format!("No agent session found for {session_id}."))
    }

    /// Resolves what needs the (blocking) identity store, on the caller's own thread.
    fn prime(&self) {
        self.host_id.get_or_init(|| self.mobile.host_id());
    }

    fn snapshot(&self, record: &MobileSessionRecord) -> MobileSessionSnapshot {
        mobile_session_snapshot(record, self.latest_sequence(), None)
    }

    async fn project(&self, project_id: &str) -> Fallible<Option<Value>> {
        let project = self.call("projects:get", vec![json!(project_id)]).await?;
        Ok((!project.is_null()).then_some(project))
    }

    async fn tickets(&self, project_id: &str) -> Fallible<Vec<Value>> {
        let Some(project) = self.project(project_id).await? else {
            return Err("That project no longer exists.".into());
        };
        // A files-planned project has no tracker connection, so there are no tickets to name.
        if project["planningMode"] == "files" {
            return Ok(Vec::new());
        }
        let connection = format!("project:{project_id}");
        let mut items = Vec::new();
        let mut offset = 0u64;
        loop {
            let filters = json!({ "projectKeys": [], "statuses": [], "issueTypes": [], "searchText": "", "assigneeMode": "all", "grouping": "none" });
            let page = self.call("issue:list", vec![filters, json!(offset), json!(200), json!(connection)]).await?;
            let issues = page["issues"].as_array().cloned().unwrap_or_default();
            let fetched = issues.len() as u64;
            items.extend(issues);
            if page["hasMore"] != true || fetched == 0 {
                break;
            }
            offset += fetched;
        }
        Ok(items)
    }

    async fn run_summaries(&self, project_id: &str) -> Fallible<Vec<Value>> {
        let runs = self.call("workflows:listRuns", vec![json!(project_id)]).await?;
        Ok(runs.as_array().cloned().unwrap_or_default())
    }

    async fn require_run(&self, run_id: &str) -> Fallible<Value> {
        let run = self.call("workflows:getRun", vec![json!(run_id)]).await?;
        if run.is_null() { Err(format!("Run {run_id} was not found.")) } else { Ok(run) }
    }
}

fn call_sync(host: &HostContext, channel: &str, args: Vec<Value>) -> Fallible<Value> {
    let response = host.dispatch_rpc(RustRpcRequest { id: "mobile-services".into(), channel: channel.into(), args });
    if response.ok {
        Ok(response.result.unwrap_or(Value::Null))
    } else {
        Err(response.error.map_or_else(|| format!("{channel} failed."), |error| error.message))
    }
}

struct DesktopGit(HostContext);

#[async_trait]
impl MobileSessionChangesGit for DesktopGit {
    async fn status(&self, repository_path: &str) -> Fallible<GitStatusSnapshot> {
        self.0.git_service().get_git_status(repository_path).await
    }
    async fn comparison(&self, repository_path: &str, request: GitDiffRequest) -> Fallible<GitDiffDocument> {
        self.0.git_service().get_git_comparison(repository_path, request).await
    }
}

struct ScheduleStore(HostContext);

#[async_trait]
impl MobileScheduleStore for ScheduleStore {
    fn list(&self) -> Vec<ScheduledRun> {
        super::scheduled_runs::list_runs(&self.0)
    }
    fn get(&self, id: &str) -> Option<ScheduledRun> {
        super::scheduled_runs::get_run(&self.0, id)
    }
    async fn save(&self, run: ScheduledRun) -> Fallible<()> {
        super::scheduled_runs::save_run(&self.0, run).map(|_| ())
    }
}

struct ScheduleDeps {
    deps: Arc<DesktopMobileDeps>,
}

#[async_trait]
impl MobileScheduleDeps for ScheduleDeps {
    fn store(&self) -> Arc<dyn MobileScheduleStore> {
        Arc::new(ScheduleStore(self.deps.host.clone()))
    }
    async fn tickets(&self, project_id: &str) -> Fallible<Vec<ScheduledTicketRef>> {
        Ok(self
            .deps
            .tickets(project_id)
            .await?
            .iter()
            .map(|item| ScheduledTicketRef {
                connection_id: format!("project:{project_id}"),
                issue_key: item["key"].as_str().unwrap_or_default().to_owned(),
                title: item["summary"].as_str().unwrap_or_default().to_owned(),
            })
            .collect())
    }
    fn changed(&self, _project_id: &str) {
        super::scheduled_runs::announce_changed(&self.deps.host);
    }
    async fn default_workflow(&self, project_id: &str) -> Fallible<Option<String>> {
        let choices = self.deps.call("scheduledRuns:workflowChoices", vec![json!(project_id)]).await?;
        Ok(choices["defaultWorkflowId"].as_str().map(str::to_owned))
    }
    async fn start_now(&self) -> Fallible<()> {
        let host = self.deps.host.clone();
        tokio::task::spawn_blocking(move || super::scheduled_runner_host::tick_now(&host)).await.map_err(|e| e.to_string())
    }
}

fn project_summary(project: &Value) -> MobileProjectSummary {
    let workflow = project["workflowStages"]
        .as_array()
        .map(|stages| stages.iter().filter_map(|stage| stage["name"].as_str()).collect::<Vec<_>>().join(" → "))
        .filter(|text| !text.is_empty());
    MobileProjectSummary {
        project_id: project["id"].as_str().unwrap_or_default().to_owned(),
        name: project["name"].as_str().unwrap_or_default().to_owned(),
        workflow,
    }
}

#[async_trait]
impl MobileHostServiceDeps for DesktopMobileDeps {
    fn host_id(&self) -> String {
        self.host_id.get().cloned().unwrap_or_default()
    }
    fn host_name(&self) -> String {
        self.mobile.host_name()
    }
    fn host_online(&self) -> bool {
        true
    }
    fn host_epoch(&self) -> String {
        self.epoch.clone()
    }
    fn latest_sequence(&self) -> u64 {
        self.mobile.latest_sequence()
    }
    fn schedules(&self) -> Option<Arc<dyn MobileSchedules>> {
        Some(create_mobile_schedules(ScheduleDeps { deps: self.self_arc() }))
    }

    async fn provider_catalog(&self, project_id: Option<&str>) -> Fallible<MobileProviderCatalog> {
        let settings = self.host.settings().read();
        let (active, analysis_prompt, working_directory) = (
            settings.ai.active_provider.clone(),
            settings.ai.analysis_prompt.trim().to_owned(),
            settings.ai.working_directory.trim().to_owned(),
        );
        drop(settings);
        let statuses = self.call("ai:listProviderStatuses", vec![]).await?;
        let providers: Vec<MobileProviderOption> = statuses
            .as_array()
            .into_iter()
            .flatten()
            .map(|status| {
                let provider = status["provider"].as_str().unwrap_or_default().to_owned();
                let label = status["label"].as_str().unwrap_or(&provider).to_owned();
                let cli = status["kind"] == "cli-agent";
                let default_model = status["defaultModel"].as_str().map(str::trim).filter(|m| !m.is_empty()).map(str::to_owned);
                let base = MobileProviderOption {
                    provider,
                    label: label.clone(),
                    kind: if cli { "cli-agent" } else { "api" }.into(),
                    available: true,
                    unavailable_reason: None,
                    unavailable_message: None,
                    default_model,
                };
                if status["enabled"] == false {
                    MobileProviderOption {
                        available: false,
                        unavailable_reason: Some("disabled".into()),
                        unavailable_message: Some(format!("{label} is turned off on the desktop (Settings → AI Provider).")),
                        ..base
                    }
                } else if status["configured"] != true {
                    let (reason, message) = if cli {
                        ("cli-unavailable", format!("{label} is not installed on the desktop, or Praxis cannot find it."))
                    } else {
                        ("not-configured", format!("{label} has no API key on the desktop. Add one in Settings → AI Provider."))
                    };
                    MobileProviderOption { available: false, unavailable_reason: Some(reason.into()), unavailable_message: Some(message), ..base }
                } else {
                    base
                }
            })
            .collect();
        let project = match project_id {
            Some(id) => self.project(id).await?,
            None => None,
        };
        let chat_tools = project.as_ref().and_then(|p| p["defaultAiToolMode"].as_str()).unwrap_or("full");
        let has_folder = project.as_ref().and_then(|p| p["workspaceFolder"].as_str()).is_some_and(|f| !f.trim().is_empty()) || !working_directory.is_empty();
        let session_modes = vec![
            if chat_tools == "full" && !has_folder {
                MobileSessionModeOption {
                    mode: "chat".into(),
                    available: false,
                    tool_access: "full".into(),
                    unavailable_message: Some("This project needs a working folder on the desktop before a full-tools chat can start.".into()),
                }
            } else {
                MobileSessionModeOption {
                    mode: "chat".into(),
                    available: true,
                    tool_access: if chat_tools == "read-only" { "read-only" } else { "full" }.into(),
                    unavailable_message: None,
                }
            },
            if analysis_prompt.is_empty() {
                MobileSessionModeOption {
                    mode: "analysis".into(),
                    available: false,
                    tool_access: "read-only".into(),
                    unavailable_message: Some("Set an analysis system prompt under Settings → AI Provider on the desktop first.".into()),
                }
            } else {
                MobileSessionModeOption { mode: "analysis".into(), available: true, tool_access: "read-only".into(), unavailable_message: None }
            },
            MobileSessionModeOption { mode: "review".into(), available: true, tool_access: "read-only".into(), unavailable_message: None },
        ];
        let default_model = providers.iter().find(|option| option.provider == active).and_then(|option| option.default_model.clone());
        Ok(MobileProviderCatalog { default_provider: active, default_model, providers, session_modes })
    }

    async fn model_catalog(&self, provider: &str, refresh: bool) -> Fallible<MobileModelCatalog> {
        let statuses = self.call("ai:listProviderStatuses", vec![]).await?;
        let status = statuses
            .as_array()
            .into_iter()
            .flatten()
            .find(|status| status["provider"] == provider)
            .cloned()
            .ok_or_else(|| format!("“{provider}” is not an AI provider this desktop knows."))?;
        let label = status["label"].as_str().unwrap_or(provider).to_owned();
        let cli = status["kind"] == "cli-agent";
        let listed = if cli {
            self.call("ai:listCliModelOptions", vec![json!(provider)]).await
        } else {
            self.call("ai:listApiModelOptions", vec![json!(provider), json!(refresh)]).await
        };
        let unavailable = |message: String| MobileModelCatalog { provider: provider.to_owned(), status: "unavailable".into(), message: Some(message), default_model: None, models: Vec::new() };
        let options = match listed {
            Ok(options) => options,
            Err(message) => return Ok(unavailable(message)),
        };
        if options.is_null() {
            return Ok(if cli {
                MobileModelCatalog { provider: provider.to_owned(), status: "ok".into(), message: Some(format!("{label} uses its own default model.")), default_model: None, models: Vec::new() }
            } else {
                unavailable(format!("The desktop could not load {label}’s model list. Check its API key and network on the desktop."))
            });
        }
        Ok(MobileModelCatalog {
            provider: provider.to_owned(),
            status: "ok".into(),
            message: None,
            default_model: options["currentValue"].as_str().filter(|v| !v.is_empty()).map(str::to_owned),
            models: options["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|option| MobileModelOption {
                    model_id: option["value"].as_str().unwrap_or_default().to_owned(),
                    name: option["name"].as_str().unwrap_or_default().to_owned(),
                    context_length: Some(option["contextLength"].clone()).filter(|v| !v.is_null() && v != &json!(0)),
                })
                .collect(),
        })
    }

    async fn describe_device(&self, device_id: &str) -> Fallible<MobileDeviceRecord> {
        let mobile = Arc::clone(&self.mobile);
        let id = device_id.to_owned();
        let (device, fingerprint, access_mode) = tokio::task::spawn_blocking(move || mobile.device_view(&id)).await.map_err(|e| e.to_string())?;
        let mut projects = Vec::new();
        for project_id in device.as_ref().and_then(|d| d.project_ids.clone()).unwrap_or_default() {
            let name = self.project(&project_id).await.ok().flatten().and_then(|p| p["name"].as_str().map(str::to_owned)).unwrap_or_else(|| project_id.clone());
            projects.push(MobileProjectRef { project_id, name });
        }
        Ok(MobileDeviceRecord {
            label: device.as_ref().map(|d| d.label.clone()).filter(|l| !l.is_empty()),
            projects,
            paired_at: device.as_ref().map(|d| d.paired_at.clone()).filter(|p| !p.is_empty()),
            last_seen_at: device.as_ref().and_then(|d| d.last_seen_at.clone()),
            host_name: self.host_name(),
            host_key_fingerprint: fingerprint,
            access_mode,
        })
    }

    async fn list_projects(&self) -> Fallible<Vec<MobileProjectSummary>> {
        let projects = self.call("projects:list", vec![]).await?;
        Ok(projects.as_array().into_iter().flatten().map(project_summary).collect())
    }

    async fn get_project(&self, project_id: &str) -> Fallible<Option<MobileProjectSummary>> {
        Ok(self.project(project_id).await?.as_ref().map(project_summary))
    }

    async fn list_work(&self, project_id: &str) -> Fallible<Value> {
        if self.project(project_id).await?.is_none() {
            return Ok(json!([]));
        }
        let mut runs_by_work: HashMap<String, String> = HashMap::new();
        for run in self.run_summaries(project_id).await? {
            if let (Some(key), Some(id)) = (run["issueKey"].as_str().filter(|k| !k.is_empty()), run["runId"].as_str()) {
                runs_by_work.insert(key.to_owned(), id.to_owned());
            }
        }
        Ok(Value::Array(
            self.tickets(project_id)
                .await?
                .iter()
                .map(|item| {
                    let key = item["key"].as_str().unwrap_or_default();
                    let mut work = json!({ "workId": key, "title": item["summary"], "status": item["status"] });
                    if let Some(run_id) = runs_by_work.get(key) {
                        work["runId"] = json!(run_id);
                    }
                    work
                })
                .collect(),
        ))
    }

    async fn list_sessions(&self, project_id: Option<&str>) -> Fallible<Vec<MobileSessionSummary>> {
        Ok(self.sessions(project_id).await?.iter().map(mobile_session_summary).collect())
    }

    async fn get_session(&self, session_id: &str) -> Fallible<Option<MobileSessionSnapshot>> {
        Ok(self.full_record(session_id).await?.map(|record| self.snapshot(&record)))
    }

    async fn list_workflows(&self, project_id: &str) -> Fallible<Value> {
        let choices = self.call("scheduledRuns:workflowChoices", vec![json!(project_id)]).await?;
        Ok(choices["choices"].clone())
    }

    async fn list_runs(&self, project_id: &str) -> Fallible<Value> {
        let mut runs = self.run_summaries(project_id).await?;
        runs.retain(|run| run["archived"] != true);
        runs.sort_by(|a, b| b["startedAt"].as_str().unwrap_or_default().cmp(a["startedAt"].as_str().unwrap_or_default()));
        let sequence = self.latest_sequence();
        let snapshots = runs
            .into_iter()
            .filter_map(|run| serde_json::from_value::<MobileRunSummaryInput>(run).ok())
            .map(|summary| serde_json::to_value(mobile_run_snapshot(&summary, sequence)).unwrap_or(Value::Null))
            .collect();
        Ok(Value::Array(snapshots))
    }

    async fn get_run(&self, run_id: &str) -> Fallible<Option<Value>> {
        let run = self.call("workflows:getRun", vec![json!(run_id)]).await?;
        Ok((!run.is_null()).then_some(run))
    }

    async fn list_run_changes(&self, run_id: &str) -> Fallible<Value> {
        let run = self.require_run(run_id).await?;
        Ok(json!({ "runId": run_id, "stages": run["stages"].clone() }))
    }

    async fn session_changes(&self, session_id: &str) -> Fallible<Value> {
        let record = self.require_record(session_id).await?;
        let changes = read_mobile_session_changes(&record, &DesktopGit(self.host.clone())).await;
        serde_json::to_value(changes).map_err(|e| e.to_string())
    }

    async fn session_file_diff(&self, session_id: &str, path: &str) -> Fallible<Value> {
        let record = self.require_record(session_id).await?;
        let diff = read_mobile_session_file_diff(&record, path, &DesktopGit(self.host.clone()), MAX_MOBILE_DIFF_LINES).await?;
        serde_json::to_value(diff).map_err(|e| e.to_string())
    }

    async fn session_image_preview(&self, session_id: &str, params: MobileImagePreviewParams) -> Fallible<Option<Value>> {
        let record = self.require_record(session_id).await?;
        let Some(path) = params.path.filter(|p| !p.is_empty()) else { return Ok(None) };
        // Only an image the session itself produced or referenced may be previewed.
        let referenced = record.events.iter().any(|event| {
            event.detail.as_deref().is_some_and(|d| d.contains(&path)) || event.summary.contains(&path) || event.data.as_ref().is_some_and(|d| d.to_string().contains(&path))
        });
        if !referenced {
            return Err("That image is not part of this session.".into());
        }
        let preview = self.call("ai:loadImagePreview", vec![json!(record.issue_key), json!(path)]).await?;
        Ok((!preview.is_null()).then_some(preview))
    }

    fn find_gadget(&self, session_id: &str, gadget_id: &str) -> Option<Value> {
        let blocks = call_sync(&self.host, "gadgets:getBlocks", vec![json!(session_id)]).ok()?;
        blocks.as_array()?.iter().find(|block| block["gadget"]["gadgetId"] == gadget_id).map(|block| block["gadget"].clone())
    }

    async fn submit_gadget(&self, session_id: &str, payload: MobileGadgetSubmitPayload, _actor: &str) -> Fallible<Value> {
        self.call(
            "gadgets:submit",
            vec![json!({
                "sessionId": session_id, "gadgetId": payload.gadget_id, "actionId": payload.action_id,
                "value": payload.value, "idempotencyKey": payload.idempotency_key
            })],
        )
        .await
    }

    async fn list_attention(&self, project_id: &str) -> Fallible<Value> {
        let host_id = self.host_id();
        let mut items: Vec<Value> = Vec::new();
        let mut records = Vec::new();
        for summary in self.sessions(Some(project_id)).await? {
            if summary.state == "awaiting_approval"
                && let Some(record) = self.full_record(&summary.session_id).await?
            {
                records.push(record);
            }
        }
        for request in praxis_mobile::host::permissions::pending_mobile_permissions(records.iter()) {
            if request.project_id.as_deref() == Some(project_id) {
                items.push(json!({
                    "id": format!("permission:{}", request.request_id), "kind": "permission", "hostId": host_id, "projectId": project_id,
                    "sessionId": request.session_id, "requestId": request.request_id, "summary": request.summary,
                    "detail": request.detail, "createdAt": request.created_at, "resolved": false
                }));
            }
        }
        for run in self.run_summaries(project_id).await? {
            let (run_id, name) = (run["runId"].as_str().unwrap_or_default(), run["workflowName"].as_str().unwrap_or_default());
            if run["status"] == "awaiting-approval" {
                items.push(json!({ "id": format!("approval:{run_id}"), "kind": "approval", "hostId": host_id, "projectId": project_id, "runId": run_id, "summary": name, "createdAt": run["startedAt"], "resolved": false }));
            }
            for stage in run["stages"].as_array().into_iter().flatten() {
                if stage["outcome"] == "failed" {
                    let node = stage["nodeId"].as_str().unwrap_or_default();
                    items.push(json!({
                        "id": format!("failure:{run_id}:{node}"), "kind": "failure", "hostId": host_id, "projectId": project_id, "runId": run_id, "nodeId": node,
                        "summary": format!("{name} — {}", stage["name"].as_str().unwrap_or_default()), "createdAt": run["startedAt"], "resolved": false
                    }));
                }
            }
        }
        Ok(Value::Array(items))
    }

    async fn create_session(&self, input: MobileCreateSession) -> Fallible<MobileSessionSnapshot> {
        let project = self.project(&input.project_id).await?.ok_or_else(|| format!("Project {} was not found.", input.project_id))?;
        let key = format!("SESSION-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let issue = json!({
            "key": key, "summary": input.title, "issueType": "Task", "status": "New",
            "projectKey": project["key"].as_str().unwrap_or("SESSION")
        });
        // Analysis and Review are read-only by contract; a chat uses the project's default tools.
        let tool_mode = if input.mode == "chat" { project["defaultAiToolMode"].as_str().unwrap_or("full").to_owned() } else { "read-only".into() };
        let mut request = json!({
            "issue": issue, "projectId": input.project_id, "provider": input.provider, "mode": input.mode, "toolMode": tool_mode,
            "task": {
                "goal": input.message,
                "scope": format!("Project {} ({}) and its configured working folder.", project["name"].as_str().unwrap_or_default(), input.project_id),
                "definitionOfDone": "Respond to the user and remain available for follow-up turns."
            }
        });
        if let Some(model) = input.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            request["model"] = json!(model);
        }
        let record = self.call("ai:delegate", vec![request]).await?;
        let issue_key = record["issueKey"].as_str().unwrap_or(&key).to_owned();
        let _ = self.call("ai:renameSession", vec![json!(issue_key), json!(input.title)]).await;
        let record = self.require_record(&issue_key).await?;
        Ok(self.snapshot(&record))
    }

    async fn start_run(&self, input: MobileStartRun) -> Fallible<Value> {
        let title = input.task.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or("Started from Praxis mobile").to_owned();
        self.call("workflows:startRun", vec![json!(input.project_id), json!(input.workflow_id), json!(title)]).await
    }

    async fn cancel_run(&self, run_id: &str, reason: Option<&str>, _actor: &str) -> Fallible<Value> {
        self.call("workflows:cancelRun", vec![json!(run_id), json!(reason)]).await?;
        self.require_run(run_id).await
    }

    async fn retry_stage(&self, run_id: &str, node_id: &str, _actor: &str) -> Fallible<Value> {
        self.call("workflows:retryStage", vec![json!(run_id), json!(node_id)]).await?;
        self.require_run(run_id).await
    }

    async fn approve_run(&self, run_id: &str, actor: &str, note: Option<&str>) -> Fallible<Value> {
        self.call("workflows:approveRun", vec![json!(run_id), json!(actor), json!(note)]).await?;
        self.require_run(run_id).await
    }

    async fn reject_run(&self, _run_id: &str, _actor: &str, _reason: &str) -> Fallible<Value> {
        Err("Rejecting a workflow gate from the phone is not available in this build. Reject it on the desktop.".into())
    }

    async fn continue_session(&self, session_id: &str, message: &str, _actor: &str) -> Fallible<Value> {
        let record = self.require_record(session_id).await?;
        if super::acp_host::has_active_task(&self.host.config().user_data_dir, &record.issue_key) {
            return Err("This session already has an active turn.".into());
        }
        self.call("ai:continueSession", vec![json!(record.issue_key), json!(message)]).await?;
        let record = self.require_record(session_id).await?;
        serde_json::to_value(self.snapshot(&record)).map_err(|e| e.to_string())
    }

    async fn configure_session(&self, session_id: &str, change: MobileSessionRuntimeChange, _actor: &str) -> Fallible<MobileSessionSnapshot> {
        let record = self.require_record(session_id).await?;
        let key = json!(record.issue_key);
        if let Some(mode) = change.mode {
            self.call("ai:switchSessionMode", vec![key.clone(), json!(mode)]).await?;
        }
        if let Some(model) = change.model {
            self.call("ai:updateSessionModel", vec![key.clone(), json!(model)]).await?;
        }
        if let Some(handover) = change.handover {
            let revision = self.call("ai:getSession", vec![key.clone()]).await?["handoverBrief"]["revision"].as_u64().unwrap_or(0);
            let mut input = json!({ "provider": handover.provider, "expectedBriefRevision": revision });
            if let Some(model) = handover.model {
                input["model"] = json!(model);
            }
            self.call("ai:handoverSession", vec![key.clone(), input]).await?;
        }
        let record = self.require_record(session_id).await?;
        Ok(self.snapshot(&record))
    }

    async fn cancel_session(&self, session_id: &str, _actor: &str) -> Fallible<Value> {
        let record = self.require_record(session_id).await?;
        self.call("ai:abort", vec![json!(record.issue_key)]).await?;
        let record = self.require_record(session_id).await?;
        serde_json::to_value(self.snapshot(&record)).map_err(|e| e.to_string())
    }

    async fn respond_to_permission(&self, request_id: &str, decision: MobilePermissionAnswer, _actor: &str, project_id: &str) -> Fallible<Value> {
        let mut records = Vec::new();
        for summary in self.sessions(Some(project_id)).await? {
            if summary.state == "awaiting_approval"
                && let Some(record) = self.full_record(&summary.session_id).await?
            {
                records.push(record);
            }
        }
        let dir = self.host.config().user_data_dir.clone();
        let response = respond_to_mobile_permission(
            records.iter(),
            request_id,
            project_id,
            decision,
            |key| super::acp_host::has_active_task(&dir, key),
            |key, decision| {
                let decision = match decision {
                    praxis_mobile::host::permissions::PermissionDecision::AllowOnce => super::acp_host::Decision::AllowOnce,
                    praxis_mobile::host::permissions::PermissionDecision::AllowAlways => super::acp_host::Decision::AllowAlways,
                    praxis_mobile::host::permissions::PermissionDecision::Deny => super::acp_host::Decision::Deny,
                };
                super::acp_host::respond_to_permission(&dir, key, decision);
            },
        )?;
        serde_json::to_value(response).map_err(|e| e.to_string())
    }
}

impl DesktopMobileDeps {
    fn self_arc(&self) -> Arc<DesktopMobileDeps> {
        Arc::new(DesktopMobileDeps { host: self.host.clone(), mobile: Arc::clone(&self.mobile), epoch: self.epoch.clone(), host_id: Arc::clone(&self.host_id) })
    }
}

/// Answers the listener's `mobile:internal:read` / `mobile:internal:command`.
pub fn register(host: &HostContext, mobile: &Arc<MobileHost>) {
    let deps = DesktopMobileDeps::new(host, mobile);
    let tables: Arc<OnceLock<Tables>> = Arc::new(OnceLock::new());
    let build = {
        let deps = Arc::clone(&deps);
        move || {
            let shared: Arc<dyn MobileHostServiceDeps> = deps.clone();
            let commands = create_mobile_host_execution_handlers(Arc::clone(&shared));
            let operations = command_operations(&shared);
            let reads = create_mobile_host_reads(shared, operations);
            let app = MobileHostApplication {
                reads: reads.clone(),
                commands,
                ledger: Arc::new(InMemoryMobileCommandLedger::default()),
                payload_digest: default_payload_digest(),
            };
            Tables { reads, app }
        }
    };

    let (read_deps, command_deps) = (Arc::clone(&deps), Arc::clone(&deps));
    let read_tables = Arc::clone(&tables);
    let read_build = build.clone();
    host.register_handler("mobile:internal:read", move |_, args| {
        let request: MobileReadRequest = serde_json::from_value(args.first().cloned().unwrap_or(Value::Null))
            .map_err(|error| failure(format!("Malformed phone read: {error}")))?;
        read_deps.prime();
        let tables = read_tables.get_or_init(&read_build);
        let handler = tables.reads.get(&request.operation).cloned().ok_or_else(|| rpc_error("Read operation is not available."))?;
        runtime::block_on(handler(request)).map_err(|error| rpc_error(&error.0))
    });
    let command_tables = tables;
    host.register_handler("mobile:internal:command", move |_, args| {
        let command: MobileCommand = serde_json::from_value(args.first().cloned().unwrap_or(Value::Null))
            .map_err(|error| failure(format!("Malformed phone command: {error}")))?;
        command_deps.prime();
        let tables = command_tables.get_or_init(&build);
        runtime::block_on(handle_mobile_command(&tables.app, command)).map_err(|error| rpc_error(&error.0))
    });
}

fn rpc_error(message: &str) -> RustRpcError {
    RustRpcError { code: "MOBILE_HOST_ERROR".into(), message: message.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_summaries_join_the_workflow_stage_names() {
        let summary = project_summary(&json!({ "id": "p1", "name": "Mobile", "workflowStages": [{ "name": "To do" }, { "name": "Done" }] }));
        assert_eq!(summary, MobileProjectSummary { project_id: "p1".into(), name: "Mobile".into(), workflow: Some("To do → Done".into()) });
        assert_eq!(project_summary(&json!({ "id": "p2", "name": "Bare" })).workflow, None);
    }
}
