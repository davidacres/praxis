//! The desktop's read and command surface a paired phone drives
//! (`apps/praxis-desktop/main/src/main/mobileHostServices.ts` port).
//!
//! Expressed over [`MobileHostServiceDeps`], the narrow port the host implements from its running
//! session, workflow and project services (whose desktop adapters are not wired to Rust yet), so the handlers test
//! with fakes. Capability checks (and command envelope validation) are supplied by
//! [`handle_mobile_read`](super::application::handle_mobile_read) /
//! [`handle_mobile_command`](super::application::handle_mobile_command); these add field
//! extraction, fail-closed errors for missing identifiers, project scoping of every resource id,
//! and an actor taken from the authenticated caller — never from the payload. The transport
//! must replace the supplied caller with the paired identity, enforce the device's project
//! grant, and filter project listings before exposing these handlers to a phone. Resource
//! checks here bind an id to the requested project; they do not authorize that project.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use praxis_workflows::scheduled_run::MissedResolution;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::application::{
    HostResult, MobileExecutionHandlers, MobileHostError, MobileHostReads, command_handler,
    read_handler,
};
use super::gadget_text::{describe_gadget_answer, is_gadget_action_value};
use super::js_text::js_slice;
use super::permissions::MobilePermissionAnswer;
use super::protocol::{
    MOBILE_HOST_SURFACE_REVISION, MOBILE_PROTOCOL_VERSION, MobileCaller, MobileCapability,
    MobileCommand, MobileCommandOperation, MobileReadOperation, MobileReadRequest, MobileTarget,
    trimmed,
};
use super::scheduled_runs::{MobileScheduleInput, MobileSchedules};
use super::session_projection::{
    MobileSessionLifecycle, MobileSessionSnapshot, MobileSessionSummary,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileProjectSummary {
    pub project_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
}

/// A provider as the phone may see it — never keys, key sources, URLs or CLI paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileProviderOption {
    pub provider: String,
    pub label: String,
    /// `api` | `cli-agent`.
    pub kind: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSessionModeOption {
    pub mode: String,
    pub available: bool,
    pub tool_access: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileProviderCatalog {
    pub default_provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub providers: Vec<MobileProviderOption>,
    pub session_modes: Vec<MobileSessionModeOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileModelOption {
    pub model_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_length: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileModelCatalog {
    pub provider: String,
    /// `ok` | `unavailable` | `provider-unavailable`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub models: Vec<MobileModelOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileProjectRef {
    pub project_id: String,
    pub name: String,
}

/// What the desktop knows about a paired device, minus what the caller already proves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDeviceRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Empty when the grant is not project-scoped.
    pub projects: Vec<MobileProjectRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    pub host_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key_fingerprint: Option<String>,
    pub access_mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileHandover {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// A validated between-turn change: mode, then model, then (last, as it starts a turn) a handover.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSessionRuntimeChange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handover: Option<MobileHandover>,
}

impl MobileSessionRuntimeChange {
    pub fn is_empty(&self) -> bool {
        self.mode.is_none() && self.model.is_none() && self.handover.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileCreateSession {
    pub project_id: String,
    pub title: String,
    pub message: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileStartRun {
    pub project_id: String,
    pub workflow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGadgetSubmitPayload {
    pub gadget_id: String,
    pub action_id: String,
    pub value: Value,
    /// Stable per logical answer, so a retried command cannot record it twice.
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileImagePreviewParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_index: Option<i64>,
    pub offset: i64,
}

/// The host's session, workflow, project, git and gadget services, as the phone surface needs
/// them. Every fallible call's `Err` is a message the phone may show.
#[async_trait]
pub trait MobileHostServiceDeps: Send + Sync {
    fn host_id(&self) -> String;
    fn host_name(&self) -> String;
    fn host_online(&self) -> bool;
    /// Changes when the desktop process restarts (event sequences restart with it).
    fn host_epoch(&self) -> String;
    fn latest_sequence(&self) -> u64;
    /// The desktop's current theme as colours; `None` until a window has applied one.
    fn appearance(&self) -> Option<Value> {
        None
    }
    /// Project-scoped schedules, when this desktop serves them.
    fn schedules(&self) -> Option<Arc<dyn MobileSchedules>> {
        None
    }

    async fn provider_catalog(
        &self,
        project_id: Option<&str>,
    ) -> Result<MobileProviderCatalog, String>;
    async fn model_catalog(
        &self,
        provider: &str,
        refresh: bool,
    ) -> Result<MobileModelCatalog, String>;
    async fn describe_device(&self, device_id: &str) -> Result<MobileDeviceRecord, String>;

    async fn list_projects(&self) -> Result<Vec<MobileProjectSummary>, String>;
    async fn get_project(&self, project_id: &str) -> Result<Option<MobileProjectSummary>, String>;
    async fn list_work(&self, project_id: &str) -> Result<Value, String>;
    async fn list_sessions(
        &self,
        project_id: Option<&str>,
    ) -> Result<Vec<MobileSessionSummary>, String>;
    async fn get_session(&self, session_id: &str) -> Result<Option<MobileSessionSnapshot>, String>;
    async fn list_workflows(&self, project_id: &str) -> Result<Value, String>;
    /// The project's workflow runs, newest first, archived ones left out.
    async fn list_runs(&self, project_id: &str) -> Result<Value, String>;
    /// A run, carrying at least its `projectId`.
    async fn get_run(&self, run_id: &str) -> Result<Option<Value>, String>;
    async fn list_run_changes(&self, run_id: &str) -> Result<Value, String>;
    async fn session_changes(&self, session_id: &str) -> Result<Value, String>;
    /// Refused for a path the session's status does not list.
    async fn session_file_diff(&self, session_id: &str, path: &str) -> Result<Value, String>;
    async fn session_image_preview(
        &self,
        session_id: &str,
        params: MobileImagePreviewParams,
    ) -> Result<Option<Value>, String>;
    /// The gadget envelope as the host holds it.
    fn find_gadget(&self, session_id: &str, gadget_id: &str) -> Option<Value>;
    /// The `GadgetActionResult` (its `status` decides whether the agent hears the answer).
    async fn submit_gadget(
        &self,
        session_id: &str,
        payload: MobileGadgetSubmitPayload,
        actor: &str,
    ) -> Result<Value, String>;
    async fn list_attention(&self, project_id: &str) -> Result<Value, String>;

    async fn create_session(
        &self,
        input: MobileCreateSession,
    ) -> Result<MobileSessionSnapshot, String>;
    async fn start_run(&self, input: MobileStartRun) -> Result<Value, String>;
    async fn cancel_run(
        &self,
        run_id: &str,
        reason: Option<&str>,
        actor: &str,
    ) -> Result<Value, String>;
    async fn retry_stage(&self, run_id: &str, node_id: &str, actor: &str) -> Result<Value, String>;
    async fn approve_run(
        &self,
        run_id: &str,
        actor: &str,
        note: Option<&str>,
    ) -> Result<Value, String>;
    async fn reject_run(&self, run_id: &str, actor: &str, reason: &str) -> Result<Value, String>;
    async fn continue_session(
        &self,
        session_id: &str,
        message: &str,
        actor: &str,
    ) -> Result<Value, String>;
    async fn configure_session(
        &self,
        session_id: &str,
        change: MobileSessionRuntimeChange,
        actor: &str,
    ) -> Result<MobileSessionSnapshot, String>;
    async fn cancel_session(&self, session_id: &str, actor: &str) -> Result<Value, String>;
    async fn respond_to_permission(
        &self,
        request_id: &str,
        decision: MobilePermissionAnswer,
        actor: &str,
        project_id: &str,
    ) -> Result<Value, String>;
}

pub type SharedDeps = Arc<dyn MobileHostServiceDeps>;

/// The verified caller's identity — a subject when signed in, otherwise the paired device.
pub fn mobile_actor_for(caller: &MobileCaller) -> String {
    trimmed(caller.subject.as_deref())
        .map(str::to_owned)
        .unwrap_or_else(|| caller.device_id.clone())
}

fn to_value<T: Serialize>(value: T) -> HostResult {
    serde_json::to_value(value).map_err(|error| MobileHostError::new(error.to_string()))
}

/// `String(value)` for a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
        other => other.to_string(),
    }
}

/// `String(field ?? '')`.
fn field_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

fn non_blank_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn target_field<'a>(target: &'a MobileTarget, key: &str) -> Option<&'a str> {
    match key {
        "projectId" => target.project_id.as_deref(),
        "runId" => target.run_id.as_deref(),
        "sessionId" => target.session_id.as_deref(),
        "requestId" => target.request_id.as_deref(),
        _ => None,
    }
}

/// The identifier, untrimmed (as the TS returns it), or a fail-closed error.
fn require_target(
    target: &MobileTarget,
    operation: &str,
    key: &str,
) -> Result<String, MobileHostError> {
    target_field(target, key)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| MobileHostError::new(format!("{operation} requires target.{key}.")))
}

/// What a session-scoped request needs from a read or a command.
struct Scope<'a> {
    operation: &'a str,
    target: &'a MobileTarget,
    caller: &'a MobileCaller,
}

impl<'a> From<&'a MobileReadRequest> for Scope<'a> {
    fn from(request: &'a MobileReadRequest) -> Self {
        Self {
            operation: request.operation.as_str(),
            target: &request.target,
            caller: &request.caller,
        }
    }
}

impl<'a> From<&'a MobileCommand> for Scope<'a> {
    fn from(command: &'a MobileCommand) -> Self {
        Self {
            operation: command.operation.as_str(),
            target: &command.target,
            caller: &command.caller,
        }
    }
}

async fn require_session_in_project(
    deps: &SharedDeps,
    session_id: &str,
    project_id: &str,
) -> Result<MobileSessionSnapshot, MobileHostError> {
    deps.get_session(session_id)
        .await?
        .filter(|session| session.summary.project_id.as_deref() == Some(project_id))
        .ok_or_else(|| {
            MobileHostError::new(format!(
                "Session {session_id} was not found in project {project_id}."
            ))
        })
}

static STANDALONE_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^SESSION-[0-9a-f]{6,}$").expect("regex"));

async fn require_mobile_session(
    deps: &SharedDeps,
    scope: Scope<'_>,
) -> Result<MobileSessionSnapshot, MobileHostError> {
    let session_id = require_target(scope.target, scope.operation, "sessionId")?;
    if let Some(project_id) = scope.target.project() {
        return require_session_in_project(deps, &session_id, project_id).await;
    }
    // An omitted project grants access only to standalone chats, and only to a desktop-wide
    // device. Project-scoped devices keep the existing boundary.
    let device = deps.describe_device(&scope.caller.device_id).await?;
    if !device.projects.is_empty() {
        return Err("This operation requires an authorised project.".into());
    }
    deps.get_session(&session_id)
        .await?
        .filter(|session| {
            session
                .summary
                .project_id
                .as_deref()
                .is_none_or(str::is_empty)
                && session.summary.run_id.as_deref().is_none_or(str::is_empty)
                && STANDALONE_KEY.is_match(&session.summary.session_key)
        })
        .ok_or_else(|| {
            MobileHostError::new(format!(
                "Session {session_id} was not found in standalone conversations."
            ))
        })
}

async fn require_run_in_project(
    deps: &SharedDeps,
    run_id: &str,
    project_id: &str,
) -> Result<Value, MobileHostError> {
    deps.get_run(run_id)
        .await?
        .filter(|run| run.get("projectId").and_then(Value::as_str) == Some(project_id))
        .ok_or_else(|| {
            MobileHostError::new(format!(
                "Run {run_id} was not found in project {project_id}."
            ))
        })
}

const SESSION_MODES: [&str; 3] = ["chat", "analysis", "review"];

fn unknown_provider(provider: &str) -> MobileHostError {
    MobileHostError::new(format!(
        "“{provider}” is not an AI provider this desktop knows. Refresh the provider list and choose another."
    ))
}

fn unavailable_provider(option: &MobileProviderOption) -> MobileHostError {
    MobileHostError::new(
        option
            .unavailable_message
            .clone()
            .unwrap_or_else(|| format!("{} is not available on this desktop.", option.label)),
    )
}

async fn confirm_model(
    deps: &dyn MobileHostServiceDeps,
    option: &MobileProviderOption,
    provider: &str,
    model: &str,
) -> Result<(), MobileHostError> {
    let models = deps.model_catalog(provider, false).await?;
    if models.status != "ok" {
        let detail = models
            .message
            .as_deref()
            .filter(|m| !m.is_empty())
            .map(|m| format!(" ({m})"))
            .unwrap_or_default();
        return Err(MobileHostError::new(format!(
            "Praxis could not confirm that {} offers “{model}”{detail}. Choose the provider default instead.",
            option.label
        )));
    }
    if !models
        .models
        .iter()
        .any(|candidate| candidate.model_id == model)
    {
        return Err(MobileHostError::new(format!(
            "{} on this desktop does not offer the model “{model}”. Refresh the model list and choose another.",
            option.label
        )));
    }
    Ok(())
}

/// The phone's raw provider / model / mode choice.
#[derive(Debug, Clone, Default)]
pub struct MobileSessionChoice {
    pub provider: Option<Value>,
    pub model: Option<Value>,
    pub mode: Option<Value>,
}

impl MobileSessionChoice {
    fn from_payload(command: &MobileCommand) -> Self {
        Self {
            provider: command.payload_field("provider").cloned(),
            model: command.payload_field("model").cloned(),
            mode: command.payload_field("mode").cloned(),
        }
    }
}

fn mode_option<'a>(
    catalog: &'a MobileProviderCatalog,
    mode: &str,
) -> Option<&'a MobileSessionModeOption> {
    catalog
        .session_modes
        .iter()
        .find(|candidate| candidate.mode == mode)
}

fn not_a_mode(mode: &Value) -> MobileHostError {
    MobileHostError::new(format!(
        "“{}” is not a session mode. Choose Chat, Analysis or Review.",
        js_string(mode)
    ))
}

/// Checks a phone's provider / model / mode choice against what this desktop can launch.
pub async fn resolve_mobile_session_launch(
    deps: &dyn MobileHostServiceDeps,
    project_id: &str,
    requested: &MobileSessionChoice,
) -> Result<(String, Option<String>, String), MobileHostError> {
    let catalog = deps.provider_catalog(Some(project_id)).await?;
    let provider = non_blank_string(requested.provider.as_ref())
        .unwrap_or_else(|| catalog.default_provider.clone());
    let option = catalog
        .providers
        .iter()
        .find(|candidate| candidate.provider == provider)
        .ok_or_else(|| unknown_provider(&provider))?;
    if !option.available {
        return Err(unavailable_provider(option));
    }
    let mode = match &requested.mode {
        None => "chat".to_owned(),
        Some(Value::String(text)) if text.is_empty() => "chat".to_owned(),
        Some(Value::String(text)) if SESSION_MODES.contains(&text.as_str()) => text.clone(),
        Some(other) => return Err(not_a_mode(other)),
    };
    if let Some(mode_option) = mode_option(&catalog, &mode).filter(|o| !o.available) {
        return Err(MobileHostError::new(
            mode_option
                .unavailable_message
                .clone()
                .unwrap_or_else(|| format!("{mode} sessions are not available for this project.")),
        ));
    }
    let model = requested
        .model
        .as_ref()
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    if model.is_empty() {
        return Ok((provider, None, mode));
    }
    confirm_model(deps, option, &provider, &model).await?;
    Ok((provider, Some(model), mode))
}

/// Works out what `sessions.configure` should change, refusing anything the desktop could not
/// do right now with a readable reason.
pub async fn resolve_mobile_session_change(
    deps: &dyn MobileHostServiceDeps,
    session: &MobileSessionSnapshot,
    requested: &MobileSessionChoice,
) -> Result<MobileSessionRuntimeChange, MobileHostError> {
    let summary = &session.summary;
    if session.can_cancel || summary.lifecycle == MobileSessionLifecycle::Active {
        return Err(
            "Wait for the current turn to finish before changing the provider, model or mode."
                .into(),
        );
    }
    if summary.archived {
        return Err("This session is archived. Restore it on the desktop first.".into());
    }
    let catalog = deps.provider_catalog(summary.project_id.as_deref()).await?;
    let current = summary
        .provider
        .clone()
        .unwrap_or_else(|| catalog.default_provider.clone());
    let provider = non_blank_string(requested.provider.as_ref()).unwrap_or_else(|| current.clone());
    let model = non_blank_string(requested.model.as_ref());
    let option = catalog
        .providers
        .iter()
        .find(|candidate| candidate.provider == provider);
    let mut change = MobileSessionRuntimeChange::default();

    if let Some(mode) = &requested.mode {
        if mode.as_str() != Some(summary.mode.as_str()) {
            let Some(text) = mode.as_str().filter(|m| SESSION_MODES.contains(m)) else {
                return Err(not_a_mode(mode));
            };
            if let Some(mode_option) = mode_option(&catalog, text).filter(|o| !o.available) {
                return Err(MobileHostError::new(
                    mode_option
                        .unavailable_message
                        .clone()
                        .unwrap_or_else(|| format!("{text} is not available for this project.")),
                ));
            }
            change.mode = Some(text.to_owned());
        }
    }

    let provider_changed = provider != current;
    let model_changed = model
        .as_deref()
        .is_some_and(|m| Some(m) != summary.model.as_deref());
    if provider_changed || model_changed {
        let option = option.ok_or_else(|| unknown_provider(&provider))?;
        if !option.available {
            return Err(unavailable_provider(option));
        }
        if let Some(model) = &model {
            confirm_model(deps, option, &provider, model).await?;
        }
        if provider_changed {
            change.handover = Some(MobileHandover {
                provider,
                model: model.clone(),
            });
        } else {
            change.model = model;
        }
    }
    Ok(change)
}

fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `sessions.usage`: running totals as recorded on the desktop — never estimated.
pub fn mobile_session_usage(
    snapshot: &MobileSessionSnapshot,
    provider_label: Option<&str>,
) -> Value {
    let summary = &snapshot.summary;
    let mut usage = Map::new();
    usage.insert("sessionId".into(), json!(summary.session_id));
    if let Some(provider) = summary.provider.as_deref().filter(|p| !p.is_empty()) {
        usage.insert("provider".into(), json!(provider));
    }
    if let Some(label) = provider_label.filter(|l| !l.is_empty()) {
        usage.insert("providerLabel".into(), json!(label));
    }
    if let Some(model) = summary.model.as_deref().filter(|m| !m.is_empty()) {
        usage.insert("model".into(), json!(model));
    }
    usage.insert("lifecycle".into(), json!(summary.lifecycle));
    for (key, value) in [
        ("tokenUsage", &snapshot.token_usage),
        ("contextTokens", &snapshot.context_tokens),
        ("contextLimit", &snapshot.context_limit),
        ("cost", &snapshot.cost),
    ] {
        if let Some(value) = value.as_ref().filter(|value| {
            // The TS omits falsy usage/cost objects, but keeps numeric zero context counts.
            matches!(key, "contextTokens" | "contextLimit") || json_truthy(value)
        }) {
            usage.insert(key.into(), value.clone());
        }
    }
    let reported = if snapshot.cost.as_ref().is_some_and(json_truthy) {
        "reported"
    } else {
        "not-reported"
    };
    usage.insert("costStatus".into(), json!(reported));
    usage.insert("sequence".into(), json!(snapshot.sequence));
    Value::Object(usage)
}

/// Reads registered in the order the TS registers them (`host.info` lists them in this order).
fn read_operations(deps: &SharedDeps) -> Vec<MobileReadOperation> {
    use MobileReadOperation as Op;
    let mut operations = vec![
        Op::HostsList,
        Op::HostInfo,
        Op::ProvidersList,
        Op::ModelsList,
        Op::SessionsUsage,
        Op::AccessGet,
        Op::ProjectsSnapshot,
        Op::WorkList,
        Op::SessionsList,
        Op::SessionsGet,
        Op::WorkflowsList,
        Op::WorkflowRunsList,
        Op::WorkflowRunsGet,
        Op::ChangesGet,
        Op::AttentionList,
        Op::SessionsImagePreview,
    ];
    if deps.schedules().is_some() {
        operations.push(Op::ScheduledRunsList);
    }
    operations
}

/// The command operations the execution handlers register, in their order.
pub fn command_operations(deps: &SharedDeps) -> Vec<MobileCommandOperation> {
    create_mobile_host_execution_handlers(deps.clone())
        .keys()
        .copied()
        .collect()
}

async fn read(
    deps: SharedDeps,
    operation: MobileReadOperation,
    request: MobileReadRequest,
    command_operations: Arc<Vec<MobileCommandOperation>>,
) -> HostResult {
    use MobileReadOperation as Op;
    let name = request.operation.as_str();
    let project = request.target.project().map(str::to_owned);
    match operation {
        Op::HostsList => Ok(json!([
            { "hostId": deps.host_id(), "hostName": deps.host_name(), "online": deps.host_online() }
        ])),
        Op::HostInfo => {
            let mut info = Map::new();
            info.insert("hostId".into(), json!(deps.host_id()));
            info.insert("hostName".into(), json!(deps.host_name()));
            info.insert("protocolVersion".into(), json!(MOBILE_PROTOCOL_VERSION));
            info.insert(
                "surfaceRevision".into(),
                json!(MOBILE_HOST_SURFACE_REVISION),
            );
            info.insert("readOperations".into(), to_value(read_operations(&deps))?);
            info.insert("commandOperations".into(), to_value(&*command_operations)?);
            if deps.schedules().is_some() {
                info.insert("scheduledRunExecution".into(), json!("planning-only"));
            }
            info.insert("latestSequence".into(), json!(deps.latest_sequence()));
            info.insert("hostEpoch".into(), json!(deps.host_epoch()));
            if let Some(appearance) = deps.appearance() {
                info.insert("appearance".into(), appearance);
            }
            Ok(Value::Object(info))
        }
        Op::ProvidersList => to_value(deps.provider_catalog(project.as_deref()).await?),
        Op::ModelsList => {
            let catalog = deps.provider_catalog(project.as_deref()).await?;
            let params = request.params.clone().unwrap_or_default();
            let provider = trimmed(params.provider.as_deref())
                .map(str::to_owned)
                .unwrap_or_else(|| catalog.default_provider.clone());
            let Some(option) = catalog.providers.iter().find(|c| c.provider == provider) else {
                return Err(MobileHostError::new(format!(
                    "“{provider}” is not an AI provider this desktop knows."
                )));
            };
            if !option.available {
                return to_value(MobileModelCatalog {
                    provider,
                    status: "provider-unavailable".into(),
                    message: option.unavailable_message.clone().filter(|m| !m.is_empty()),
                    default_model: None,
                    models: Vec::new(),
                });
            }
            to_value(
                deps.model_catalog(&provider, params.refresh == Some(true))
                    .await?,
            )
        }
        Op::SessionsUsage => {
            let snapshot = require_mobile_session(&deps, Scope::from(&request)).await?;
            let label = match snapshot
                .summary
                .provider
                .as_deref()
                .filter(|p| !p.is_empty())
            {
                Some(provider) => deps
                    .provider_catalog(snapshot.summary.project_id.as_deref())
                    .await?
                    .providers
                    .into_iter()
                    .find(|option| option.provider == provider)
                    .map(|option| option.label),
                None => None,
            };
            Ok(mobile_session_usage(&snapshot, label.as_deref()))
        }
        Op::AccessGet => {
            let mut access = Map::new();
            access.insert("deviceId".into(), json!(request.caller.device_id));
            access.insert(
                "capabilities".into(),
                to_value(&request.caller.capabilities)?,
            );
            if let Value::Object(record) =
                to_value(deps.describe_device(&request.caller.device_id).await?)?
            {
                access.extend(record);
            }
            access.insert("transport".into(), json!("noise-ik"));
            access.insert("protocolVersion".into(), json!(MOBILE_PROTOCOL_VERSION));
            access.insert(
                "surfaceRevision".into(),
                json!(MOBILE_HOST_SURFACE_REVISION),
            );
            Ok(Value::Object(access))
        }
        Op::ProjectsSnapshot => match project {
            Some(project_id) => match deps.get_project(&project_id).await? {
                Some(project) => to_value(project),
                None => Err(MobileHostError::new(format!(
                    "Project {project_id} was not found."
                ))),
            },
            None => Ok(json!({ "projects": to_value(deps.list_projects().await?)? })),
        },
        Op::WorkList => Ok(deps
            .list_work(&require_target(&request.target, name, "projectId")?)
            .await?),
        Op::SessionsList => {
            if project.is_none()
                && !deps
                    .describe_device(&request.caller.device_id)
                    .await?
                    .projects
                    .is_empty()
            {
                return Err("This operation requires an authorised project.".into());
            }
            to_value(deps.list_sessions(project.as_deref()).await?)
        }
        Op::SessionsGet => to_value(require_mobile_session(&deps, Scope::from(&request)).await?),
        Op::WorkflowsList => Ok(deps
            .list_workflows(&require_target(&request.target, name, "projectId")?)
            .await?),
        Op::WorkflowRunsList => Ok(deps
            .list_runs(&require_target(&request.target, name, "projectId")?)
            .await?),
        Op::WorkflowRunsGet => {
            let run_id = require_target(&request.target, name, "runId")?;
            let project_id = require_target(&request.target, name, "projectId")?;
            require_run_in_project(&deps, &run_id, &project_id).await
        }
        Op::ChangesGet => {
            if let Some(session_id) = trimmed(request.target.session_id.as_deref()) {
                require_mobile_session(&deps, Scope::from(&request)).await?;
                let path = request
                    .params
                    .as_ref()
                    .and_then(|p| trimmed(p.path.as_deref()));
                return Ok(match path {
                    Some(path) => deps.session_file_diff(session_id, path).await?,
                    None => deps.session_changes(session_id).await?,
                });
            }
            let run_id = require_target(&request.target, name, "runId")?;
            let project_id = require_target(&request.target, name, "projectId")?;
            require_run_in_project(&deps, &run_id, &project_id).await?;
            Ok(deps.list_run_changes(&run_id).await?)
        }
        Op::AttentionList => Ok(deps
            .list_attention(&require_target(&request.target, name, "projectId")?)
            .await?),
        Op::SessionsImagePreview => image_preview(&deps, &request).await,
        Op::ScheduledRunsList => {
            let schedules = deps
                .schedules()
                .ok_or_else(|| MobileHostError::new("Read operation is not available."))?;
            to_value(
                schedules
                    .list(&require_target(&request.target, name, "projectId")?)
                    .await?,
            )
        }
    }
}

/// `Number.isSafeInteger`.
fn safe_integer(value: Option<&Value>) -> Option<i64> {
    const MAX_SAFE: i64 = (1 << 53) - 1;
    let number = value?.as_number()?;
    let integer = number.as_i64().or_else(|| {
        number
            .as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64)
            .map(|f| f as i64)
    })?;
    (-MAX_SAFE..=MAX_SAFE).contains(&integer).then_some(integer)
}

async fn image_preview(deps: &SharedDeps, request: &MobileReadRequest) -> HostResult {
    let session_id = require_target(&request.target, request.operation.as_str(), "sessionId")?;
    require_mobile_session(deps, Scope::from(request)).await?;
    let params = request.params.clone().unwrap_or_default();
    let path = trimmed(params.path.as_deref()).map(str::to_owned);
    let event_index = safe_integer(params.event_index.as_ref());
    let attachment_index = safe_integer(params.attachment_index.as_ref());
    let has_attachment = event_index.is_some() && attachment_index.is_some();
    if (path.is_none() && !has_attachment)
        || (path.is_some() && has_attachment)
        || (event_index.is_some() != attachment_index.is_some())
    {
        return Err(
            "sessions.imagePreview requires either params.path or both attachment indices.".into(),
        );
    }
    let offset = match params.offset.as_ref() {
        None | Some(Value::Null) => 0,
        Some(value) => safe_integer(Some(value))
            .filter(|o| *o >= 0)
            .ok_or_else(|| {
                MobileHostError::new(
                    "sessions.imagePreview params.offset must be a non-negative integer.",
                )
            })?,
    };
    let preview = deps
        .session_image_preview(
            &session_id,
            MobileImagePreviewParams {
                path,
                event_index: event_index.filter(|_| has_attachment),
                attachment_index: attachment_index.filter(|_| has_attachment),
                offset,
            },
        )
        .await?;
    Ok(preview.unwrap_or_else(|| json!({})))
}

/// `createMobileHostReads`. `command_operations` is what `host.info` advertises.
pub fn create_mobile_host_reads(
    deps: SharedDeps,
    command_operations: Vec<MobileCommandOperation>,
) -> MobileHostReads {
    let command_operations = Arc::new(command_operations);
    read_operations(&deps)
        .into_iter()
        .map(|operation| {
            let deps = deps.clone();
            let command_operations = command_operations.clone();
            let handler = read_handler(move |request| {
                read(deps.clone(), operation, request, command_operations.clone())
            });
            (operation, handler)
        })
        .collect()
}

fn read_gadget_submit_payload(
    command: &MobileCommand,
) -> Result<MobileGadgetSubmitPayload, MobileHostError> {
    let gadget_id = non_blank_string(command.payload_field("gadgetId"));
    let action_id = non_blank_string(command.payload_field("actionId"));
    let (Some(gadget_id), Some(action_id)) = (gadget_id, action_id) else {
        return Err("gadgets.submit requires payload.gadgetId and payload.actionId.".into());
    };
    let value = command
        .payload_field("value")
        .cloned()
        .unwrap_or(Value::Null);
    if !is_gadget_action_value(&value) {
        return Err("That answer was not in a form the desktop understands.".into());
    }
    Ok(MobileGadgetSubmitPayload {
        gadget_id,
        action_id,
        value,
        // The command id is already unique per logical submission and reused on retry.
        idempotency_key: non_blank_string(command.payload_field("idempotencyKey"))
            .unwrap_or_else(|| command.command_id.clone()),
    })
}

async fn execute(deps: SharedDeps, command: MobileCommand) -> HostResult {
    use MobileCommandOperation as Op;
    let name = command.operation.as_str();
    let target = &command.target;
    let actor = mobile_actor_for(&command.caller);
    match command.operation {
        Op::ScheduledRunsSave | Op::ScheduledRunsSetArmed | Op::ScheduledRunsResolveMissed => {
            schedule_command(&deps, &command).await
        }
        Op::SessionsCreate => {
            let project_id = require_target(target, name, "projectId")?;
            let title = field_text(command.payload_field("title")).trim().to_owned();
            let message = field_text(command.payload_field("message"))
                .trim()
                .to_owned();
            if message.is_empty() {
                return Err("sessions.create requires a non-empty payload.message.".into());
            }
            let (provider, model, mode) = resolve_mobile_session_launch(
                deps.as_ref(),
                &project_id,
                &MobileSessionChoice::from_payload(&command),
            )
            .await?;
            let title = if title.is_empty() {
                js_slice(&message, 0, 80)
            } else {
                title
            };
            to_value(
                deps.create_session(MobileCreateSession {
                    project_id,
                    title,
                    message,
                    provider,
                    model,
                    mode,
                })
                .await?,
            )
        }
        Op::SessionsContinue => {
            let session_id = require_target(target, name, "sessionId")?;
            require_mobile_session(&deps, Scope::from(&command)).await?;
            let message = field_text(command.payload_field("message"))
                .trim()
                .to_owned();
            if message.is_empty() {
                return Err("sessions.continue requires a non-empty payload.message.".into());
            }
            Ok(deps.continue_session(&session_id, &message, &actor).await?)
        }
        Op::SessionsConfigure => {
            let session_id = require_target(target, name, "sessionId")?;
            let session = require_mobile_session(&deps, Scope::from(&command)).await?;
            let change = resolve_mobile_session_change(
                deps.as_ref(),
                &session,
                &MobileSessionChoice::from_payload(&command),
            )
            .await?;
            if change.is_empty() {
                return to_value(session);
            }
            to_value(deps.configure_session(&session_id, change, &actor).await?)
        }
        Op::SessionsCancel => {
            let session_id = require_target(target, name, "sessionId")?;
            require_mobile_session(&deps, Scope::from(&command)).await?;
            Ok(deps.cancel_session(&session_id, &actor).await?)
        }
        Op::WorkflowRunsStart => {
            let project_id = require_target(target, name, "projectId")?;
            let workflow_id = field_text(command.payload_field("workflowId"))
                .trim()
                .to_owned();
            if workflow_id.is_empty() {
                return Err("workflowRuns.start requires payload.workflowId.".into());
            }
            let task = command
                .payload_field("task")
                .and_then(Value::as_str)
                .map(str::to_owned);
            Ok(deps
                .start_run(MobileStartRun {
                    project_id,
                    workflow_id,
                    task,
                })
                .await?)
        }
        Op::WorkflowRunsCancel => {
            let run_id = require_target(target, name, "runId")?;
            require_run_in_project(&deps, &run_id, &require_target(target, name, "projectId")?)
                .await?;
            let reason = command.payload_field("reason").and_then(Value::as_str);
            Ok(deps.cancel_run(&run_id, reason, &actor).await?)
        }
        Op::WorkflowRunsRetryStage => {
            let run_id = require_target(target, name, "runId")?;
            require_run_in_project(&deps, &run_id, &require_target(target, name, "projectId")?)
                .await?;
            let node_id = field_text(command.payload_field("nodeId"))
                .trim()
                .to_owned();
            if node_id.is_empty() {
                return Err("workflowRuns.retryStage requires payload.nodeId.".into());
            }
            Ok(deps.retry_stage(&run_id, &node_id, &actor).await?)
        }
        Op::PermissionsRespond => {
            let request_id = require_target(target, name, "requestId")?;
            let decision = command
                .payload_field("decision")
                .and_then(Value::as_str)
                .and_then(MobilePermissionAnswer::parse)
                .ok_or_else(|| {
                    MobileHostError::new(
                        "permissions.respond requires payload.decision of 'allow', 'allow_always', or 'deny'.",
                    )
                })?;
            let project_id = require_target(target, name, "projectId")?;
            Ok(deps
                .respond_to_permission(&request_id, decision, &actor, &project_id)
                .await?)
        }
        Op::WorkflowGatesApprove => {
            let run_id = require_target(target, name, "runId")?;
            require_run_in_project(&deps, &run_id, &require_target(target, name, "projectId")?)
                .await?;
            let note = command.payload_field("note").and_then(Value::as_str);
            Ok(deps.approve_run(&run_id, &actor, note).await?)
        }
        Op::WorkflowGatesReject => {
            let run_id = require_target(target, name, "runId")?;
            require_run_in_project(&deps, &run_id, &require_target(target, name, "projectId")?)
                .await?;
            let Some(reason) = non_blank_string(command.payload_field("reason")) else {
                return Err(
                    "Say why you are rejecting — the reason is recorded on the run.".into(),
                );
            };
            Ok(deps
                .reject_run(&run_id, &actor, &js_slice(&reason, 0, 2_000))
                .await?)
        }
        Op::GadgetsSubmit => {
            let session_id = require_target(target, name, "sessionId")?;
            require_mobile_session(&deps, Scope::from(&command)).await?;
            let payload = read_gadget_submit_payload(&command)?;
            let Some(envelope) = deps.find_gadget(&session_id, &payload.gadget_id) else {
                return Err("This gadget is no longer available on the desktop.".into());
            };
            let gated = envelope
                .get("actions")
                .and_then(Value::as_array)
                .and_then(|actions| {
                    actions.iter().find(|candidate| {
                        candidate.get("actionId").and_then(Value::as_str)
                            == Some(payload.action_id.as_str())
                    })
                })
                .is_some_and(|action| {
                    action.get("effect").and_then(Value::as_str) != Some("informational")
                });
            // Answering is a turn (execute); an answer that approves or changes something also needs approve.
            if gated && !command.caller.has(MobileCapability::Approve) {
                return Err("This phone is not allowed to approve. Grant it the approve permission in Settings › Mobile access on the desktop.".into());
            }
            let action_id = payload.action_id.clone();
            let value = payload.value.clone();
            let result = deps.submit_gadget(&session_id, payload, &actor).await?;
            let status = result.get("status").and_then(Value::as_str);
            // As on the desktop: an open decision is reported to the agent as the next turn.
            if matches!(status, Some("completed" | "accepted")) {
                if let Some(follow_up) = describe_gadget_answer(Some(&envelope), &action_id, &value)
                {
                    deps.continue_session(&session_id, &follow_up, &actor)
                        .await?;
                }
            }
            Ok(result)
        }
    }
}

async fn schedule_command(deps: &SharedDeps, command: &MobileCommand) -> HostResult {
    use MobileCommandOperation as Op;
    let schedules = deps.schedules().ok_or_else(|| {
        MobileHostError::new(format!(
            "No execution handler is registered for {}.",
            command.operation.as_str()
        ))
    })?;
    let name = command.operation.as_str();
    let id = non_blank_string(command.payload_field("id")).and(
        command
            .payload_field("id")
            .and_then(Value::as_str)
            .map(str::to_owned),
    );
    match command.operation {
        Op::ScheduledRunsSave => {
            let fields: Vec<Option<String>> = ["name", "date", "time", "timezone"]
                .iter()
                .map(|key| {
                    command
                        .payload_field(key)
                        .and_then(Value::as_str)
                        .filter(|v| !v.trim().is_empty())
                        .map(str::to_owned)
                })
                .collect();
            let keys = command.payload_field("issueKeys").and_then(Value::as_array);
            let keys: Option<Vec<String>> =
                keys.filter(|keys| keys.len() <= 200).and_then(|keys| {
                    keys.iter()
                        .map(|key| {
                            key.as_str()
                                .filter(|k| !k.trim().is_empty())
                                .map(str::to_owned)
                        })
                        .collect()
                });
            let (Some(keys), [Some(name_), Some(date), Some(time), Some(timezone)]) =
                (keys, fields.as_slice())
            else {
                return Err("A schedule needs a name, date, time, timezone and ordered project ticket keys.".into());
            };
            let project_id = require_target(&command.target, name, "projectId")?;
            to_value(
                schedules
                    .save(
                        &project_id,
                        MobileScheduleInput {
                            name: name_.clone(),
                            date: date.clone(),
                            time: time.clone(),
                            timezone: timezone.clone(),
                            issue_keys: keys,
                        },
                    )
                    .await?,
            )
        }
        Op::ScheduledRunsSetArmed => {
            let armed = command.payload_field("armed").and_then(Value::as_bool);
            let (Some(id), Some(armed)) = (id, armed) else {
                return Err("A schedule id and armed boolean are required.".into());
            };
            let project_id = require_target(&command.target, name, "projectId")?;
            to_value(schedules.set_armed(&project_id, &id, armed).await?)
        }
        _ => {
            let resolution = match command.payload_field("resolution").and_then(Value::as_str) {
                Some("start-now") => Some(MissedResolution::StartNow),
                Some("skip") => Some(MissedResolution::Skip),
                _ => None,
            };
            let (Some(id), Some(resolution)) = (id, resolution) else {
                return Err("Choose start-now or skip for a missed schedule.".into());
            };
            let project_id = require_target(&command.target, name, "projectId")?;
            to_value(
                schedules
                    .resolve_missed(&project_id, &id, resolution)
                    .await?,
            )
        }
    }
}

/// `createMobileHostExecutionHandlers`, in the TS registration order.
pub fn create_mobile_host_execution_handlers(deps: SharedDeps) -> MobileExecutionHandlers {
    use MobileCommandOperation as Op;
    let mut operations = Vec::new();
    if deps.schedules().is_some() {
        operations.extend([
            Op::ScheduledRunsSave,
            Op::ScheduledRunsSetArmed,
            Op::ScheduledRunsResolveMissed,
        ]);
    }
    operations.extend([
        Op::SessionsCreate,
        Op::SessionsContinue,
        Op::SessionsConfigure,
        Op::SessionsCancel,
        Op::WorkflowRunsStart,
        Op::WorkflowRunsCancel,
        Op::WorkflowRunsRetryStage,
        Op::PermissionsRespond,
        Op::WorkflowGatesApprove,
        Op::WorkflowGatesReject,
        Op::GadgetsSubmit,
    ]);
    operations
        .into_iter()
        .map(|operation| {
            let deps = deps.clone();
            (
                operation,
                command_handler(move |command| execute(deps.clone(), command)),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests;
