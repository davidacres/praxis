//! Scheduled ticket runs: the store, the editor's commands and the monitor's view
//! (`scheduledRunIpc.ts`, `scheduledRunInstance.ts` port).
//!
//! These channels run outside the profile lock (see `Application::dispatch`): the runner they hand
//! decisions to reads the board and starts workflow runs, which take that lock themselves.
//! Every mutation is a pure core function applied to the stored run and saved, so the rules (what is
//! editable, what arming needs, what a missed run can do) live in one tested place; starting, pausing,
//! resuming, skipping, retrying and cancelling go through the runner, which applies them in order with
//! its other work.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, PoisonError};

use chrono::{SecondsFormat, Utc};
use praxis_contracts::RustRpcRequest;
use praxis_host::HostContext;
use praxis_workflows::scheduled_run::{
    ComposeScheduledRunInput, MissedResolution, ScheduledRun, ScheduledRunStatus, ScheduledTicketRef,
    arm_scheduled_run, compose_scheduled_run, hold_scheduled_run, resolve_missed_scheduled_run,
};
use praxis_workflows::scheduled_run_readiness::{
    ScheduledReadinessContext, ScheduledTicketProbe, ScheduledTicketProbeSource, TicketProbeState,
    assess_scheduled_run_readiness,
};
use praxis_workflows::scheduled_run_store::{RUNS_KEY, ScheduledRunBackend, ScheduledRunStore};
use praxis_workflows::scheduled_run_time::{instant_to_zoned_parts, ZonedParts};
use serde_json::{Value, json};

use super::scheduled_runner_host::{self, runner};
use super::storage;
use super::workflows;
use super::{Result, failure, runtime, text};

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

struct JsonFileBackend {
    path: PathBuf,
}

impl ScheduledRunBackend for JsonFileBackend {
    fn read(&self) -> Option<Value> {
        let text = fs::read_to_string(&self.path).ok()?;
        let json: Value = serde_json::from_str(&text).ok()?;
        json.get(RUNS_KEY).cloned()
    }

    fn write(&mut self, value: Value) -> std::result::Result<(), String> {
        let mut root = fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_else(|| json!({}));
        if !root.is_object() {
            root = json!({});
        }
        root[RUNS_KEY] = value;
        let serialized = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        storage::write_atomic(&self.path, &format!("{serialized}\n"), false).map_err(|e| e.message)
    }
}

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn scheduled_runs_path(host: &HostContext) -> PathBuf {
    host.config().user_data_dir.join("scheduled-runs.json")
}

fn store(host: &HostContext) -> ScheduledRunStore<JsonFileBackend> {
    ScheduledRunStore::new(JsonFileBackend { path: scheduled_runs_path(host) })
}

// The runner's view of the store: serialised, because lanes save concurrently.

pub fn list_runs(host: &HostContext) -> Vec<ScheduledRun> {
    let _guard = store_lock().lock().unwrap_or_else(PoisonError::into_inner);
    store(host).list()
}

pub fn get_run(host: &HostContext, id: &str) -> Option<ScheduledRun> {
    let _guard = store_lock().lock().unwrap_or_else(PoisonError::into_inner);
    store(host).get(id)
}

pub fn save_run(host: &HostContext, run: ScheduledRun) -> std::result::Result<ScheduledRun, String> {
    let _guard = store_lock().lock().unwrap_or_else(PoisonError::into_inner);
    store(host).save(run)
}

fn changed(host: &HostContext) {
    host.events().emit("scheduledRuns:changed", None);
}

fn require_run(host: &HostContext, id: &str) -> Result<ScheduledRun> {
    get_run(host, id).ok_or_else(|| failure("That scheduled run no longer exists."))
}

// ── the monitor's view ───────────────────────────────────────────────────

fn rpc(host: &HostContext, channel: &str, args: Vec<Value>) -> Option<Value> {
    let response = host.dispatch_rpc(RustRpcRequest { id: "scheduled-view".into(), channel: channel.into(), args });
    if response.ok { response.result } else { None }
}

/// Whether the ticket's board has a folder to work in, when that can be known.
fn folder_for(host: &HostContext, connection_id: &str) -> Option<bool> {
    let catalog = storage::Catalog::load(&host.config().user_data_dir, &host.config().settings_path).ok()?;
    if let Some(project_id) = connection_id.strip_prefix("project:") {
        return Some(
            catalog
                .require(storage::PROJECTS, project_id)
                .ok()
                .and_then(|p| p["workspaceFolder"].as_str().map(|f| !f.trim().is_empty()))
                .unwrap_or(false),
        );
    }
    let connection = rpc(host, "connection:list", Vec::new())
        .and_then(|list| list.as_array().and_then(|l| l.iter().find(|c| c["id"] == connection_id).cloned()));
    if connection.as_ref().is_some_and(|c| c["mode"] == "folder") {
        return Some(true);
    }
    let projects = catalog.list(storage::PROJECTS);
    projects
        .iter()
        .find(|p| {
            p["linkedBoards"]
                .as_array()
                .is_some_and(|links| links.iter().any(|l| l["connectionId"] == connection_id))
        })
        .map(|p| p["workspaceFolder"].as_str().is_some_and(|f| !f.trim().is_empty()))
}

struct BoardProbe<'a> {
    host: &'a HostContext,
    others: &'a [ScheduledRun],
    self_id: &'a str,
}

impl ScheduledTicketProbeSource for BoardProbe<'_> {
    fn probe(&self, ticket: &ScheduledTicketRef) -> ScheduledTicketProbe {
        let Some(issue) = rpc(
            self.host,
            "issue:get",
            vec![json!(ticket.issue_key), json!(ticket.connection_id)],
        ) else {
            return ScheduledTicketProbe { state: TicketProbeState::Missing, ..ScheduledTicketProbe::found() };
        };
        let mut probe = ScheduledTicketProbe::found();
        probe.closed = issue["statusCategory"].as_str().is_some_and(|c| c.eq_ignore_ascii_case("done"));
        let description = issue["description"].as_str().unwrap_or("").to_lowercase();
        probe.has_acceptance_criteria = Some(
            description.contains("acceptance")
                || description.contains("definition of done")
                || description.contains("[ ]")
                || description.contains("[x]"),
        );
        probe.has_folder = folder_for(self.host, &ticket.connection_id);
        probe.in_other_schedule = self
            .others
            .iter()
            .find(|run| {
                run.id != self.self_id
                    && run.status == ScheduledRunStatus::Scheduled
                    && run.entries.iter().any(|e| {
                        e.ticket.connection_id == ticket.connection_id
                            && e.ticket.issue_key == ticket.issue_key
                    })
            })
            .map(|run| run.name.clone());
        probe
    }
}

/// A schedule with its derived readiness and editable start parts.
fn build_view(host: &HostContext, run: &ScheduledRun, all: &[ScheduledRun]) -> Value {
    let probe = BoardProbe { host, others: all, self_id: &run.id };
    let usable = scheduled_runner_host::usable_providers(host);
    let (workflow_trusted, base_dirty) = match (&run.project_id, run.policy.workflow_id()) {
        (Some(project_id), Some(workflow_id)) => match workflows::runnable_definition(host, project_id, workflow_id) {
            Some(definition) => {
                let trust = workflows::project_workflow_trust(host, project_id, workflow_id, Some(&definition), false);
                let dirty = workflows::blocking_files(host, project_id).map(|f| !f.is_empty()).unwrap_or(false);
                (Some(trust.trusted), dirty)
            }
            None => (None, false),
        },
        _ => (None, false),
    };
    let threshold = f64::from(host.settings().read().ai.provider_handover_percent) / 100.0;
    let usage = scheduled_runner_host::usage_override();
    let low_allowance = usage.as_ref().and_then(|used| {
        usable.iter().find(|p| used.get(*p).is_some_and(|u| *u >= threshold)).cloned()
    });
    let context = ScheduledReadinessContext {
        now: now(),
        probe: &probe,
        usable_provider_count: usable.len(),
        workflow_trusted,
        base_dirty,
        low_allowance_provider: low_allowance,
    };
    let readiness = assess_scheduled_run_readiness(run, &context);
    let start = instant_to_zoned_parts(&run.scheduled_start_at, &run.timezone)
        .unwrap_or(ZonedParts { date: String::new(), time: String::new() });
    let in_flight = matches!(run.status, ScheduledRunStatus::Running | ScheduledRunStatus::Paused);
    let mut view = json!({
        "run": run,
        "readiness": readiness,
        "start": { "date": start.date, "time": start.time },
    });
    if in_flight {
        let headroom: Vec<Value> = usable
            .iter()
            .map(|provider| {
                let mut entry = json!({ "provider": provider });
                if let Some(used) = usage.as_ref().and_then(|u| u.get(provider)) {
                    entry["usedFraction"] = json!(used);
                }
                entry
            })
            .collect();
        let lives: Vec<Value> = scheduled_runner_host::live_entries(host, run)
            .into_iter()
            .map(|mut live| {
                live["headroom"] = json!(headroom);
                live
            })
            .collect();
        view["headroom"] = json!(headroom);
        if !lives.is_empty() {
            view["lives"] = json!(lives);
        }
    }
    view
}

fn view_of(host: &HostContext, run: &ScheduledRun) -> Value {
    build_view(host, run, &list_runs(host))
}

// ── the editor ───────────────────────────────────────────────────────────

fn parse_ticket_refs(val: Option<&Value>) -> Vec<ScheduledTicketRef> {
    val.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let obj = item.as_object()?;
                    let connection_id = obj.get("connectionId")?.as_str()?.to_string();
                    let issue_key = obj.get("issueKey")?.as_str()?.to_string();
                    let title = obj.get("title").and_then(Value::as_str).unwrap_or(&issue_key).to_string();
                    Some(ScheduledTicketRef { connection_id, issue_key, title })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_string_list(val: Option<&Value>) -> Vec<String> {
    val.and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Prefer a ticket-owned workflow, otherwise use governed delivery (`defaultScheduleWorkflow`).
fn default_schedule_workflow(choices: &[Value]) -> Option<String> {
    choices
        .iter()
        .find(|c| c["trigger"] == "ticket")
        .or_else(|| choices.iter().find(|c| c["workflowId"] == "governed-delivery"))
        .and_then(|c| c["workflowId"].as_str().map(str::to_string))
}

fn compose_input(
    host: &HostContext,
    input: &Value,
    existing: Option<&ScheduledRun>,
    arm: bool,
    at: &str,
) -> ComposeScheduledRunInput {
    let project_id = input
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| existing.and_then(|e| e.project_id.clone()));
    let mut workflow_id = input.get("workflowId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    if workflow_id.is_none() {
        workflow_id = existing.and_then(|e| e.policy.workflow_id().cloned());
    }
    if workflow_id.is_none() {
        if let Some(project_id) = &project_id {
            workflow_id = default_schedule_workflow(&workflows::workflow_choices_for(host, project_id));
        }
    }
    ComposeScheduledRunInput {
        project_id,
        name: input.get("name").and_then(Value::as_str).unwrap_or("Scheduled run").to_string(),
        date: input.get("date").and_then(Value::as_str).unwrap_or_default().to_string(),
        time: input.get("time").and_then(Value::as_str).unwrap_or_default().to_string(),
        timezone: input.get("timezone").and_then(Value::as_str).unwrap_or("UTC").to_string(),
        tickets: parse_ticket_refs(input.get("tickets")),
        with_previous: parse_string_list(input.get("withPrevious")),
        workflow_id,
        max_concurrency: input.get("maxConcurrency").and_then(Value::as_i64),
        arm,
        at: at.to_string(),
    }
}

pub fn list(host: &HostContext) -> Result<Value> {
    scheduled_runner_host::ensure_started(host);
    let runs = list_runs(host);
    Ok(json!(runs.iter().map(|run| build_view(host, run, &runs)).collect::<Vec<_>>()))
}

pub fn get(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    Ok(get_run(host, id).map_or(Value::Null, |run| view_of(host, &run)))
}

pub fn save(host: &HostContext, args: &[Value]) -> Result<Value> {
    scheduled_runner_host::ensure_started(host);
    let input = args.first().ok_or_else(|| failure("save requires input object"))?;
    let existing = match input.get("id").and_then(Value::as_str) {
        Some(id) => Some(require_run(host, id)?),
        None => None,
    };
    let start_now = input.get("startNow").and_then(Value::as_bool).unwrap_or(false);
    let at = now();
    let mut compose = compose_input(host, input, existing.as_ref(), input.get("arm").and_then(Value::as_bool).unwrap_or(false), &at);
    if start_now {
        // An immediate start does not require a future date or a valid scheduled wall time.
        let parts = instant_to_zoned_parts(&at, &compose.timezone)
            .ok_or_else(|| failure("Choose a valid timezone before starting this run."))?;
        compose.date = parts.date;
        compose.time = parts.time;
        compose.arm = false;
    }
    let run = compose_scheduled_run(existing, compose).map_err(failure)?;
    let saved = save_run(host, run).map_err(failure)?;
    changed(host);
    if start_now {
        let started = runtime::block_on(runner(host).start_now(&saved.id)).map_err(failure)?;
        return Ok(view_of(host, &started));
    }
    Ok(view_of(host, &saved))
}

pub fn preview(host: &HostContext, args: &[Value]) -> Result<Value> {
    let input = args.first().ok_or_else(|| failure("preview requires input object"))?;
    let existing = input.get("id").and_then(Value::as_str).and_then(|id| get_run(host, id));
    let compose = compose_input(host, input, existing.as_ref(), false, &now());
    match compose_scheduled_run(existing, compose) {
        Ok(run) => {
            let view = build_view(host, &run, &list_runs(host));
            Ok(json!({ "readiness": view["readiness"] }))
        }
        Err(error) => Ok(json!({ "error": error })),
    }
}

pub fn remove(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    if let Some(run) = get_run(host, id) {
        if matches!(run.status, ScheduledRunStatus::Running | ScheduledRunStatus::Paused) {
            let _ = runtime::block_on(runner(host).cancel(id));
        }
    }
    let _guard = store_lock().lock().unwrap_or_else(PoisonError::into_inner);
    store(host).remove(id).map_err(failure)?;
    drop(_guard);
    changed(host);
    Ok(Value::Null)
}

pub fn rename(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let name = text(args, 1)?;
    let updated = {
        let _guard = store_lock().lock().unwrap_or_else(PoisonError::into_inner);
        store(host).rename(id, name, &now()).map_err(failure)?
    };
    changed(host);
    Ok(view_of(host, &updated))
}

pub fn archive(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let archived = args.get(1).and_then(Value::as_bool).ok_or_else(|| failure("archived boolean required"))?;
    let updated = {
        let _guard = store_lock().lock().unwrap_or_else(PoisonError::into_inner);
        store(host).set_archived(id, archived, &now()).map_err(failure)?
    };
    changed(host);
    Ok(view_of(host, &updated))
}

pub fn workflow_choices(host: &HostContext, args: &[Value]) -> Result<Value> {
    let project_id = text(args, 0)?;
    let choices = workflows::workflow_choices_for(host, project_id);
    Ok(json!({ "choices": choices, "defaultWorkflowId": default_schedule_workflow(&choices) }))
}

// ── decisions go through the runner ──────────────────────────────────────

fn decided(host: &HostContext, run: std::result::Result<ScheduledRun, String>) -> Result<Value> {
    let run = run.map_err(failure)?;
    changed(host);
    Ok(view_of(host, &run))
}

pub fn pause(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    decided(host, runtime::block_on(runner(host).pause(id)))
}

pub fn start_now(host: &HostContext, args: &[Value]) -> Result<Value> {
    scheduled_runner_host::ensure_started(host);
    let id = text(args, 0)?;
    decided(host, runtime::block_on(runner(host).start_now(id)))
}

pub fn resume(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    decided(host, runtime::block_on(runner(host).resume(id)))
}

pub fn cancel(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    decided(host, runtime::block_on(runner(host).cancel(id)))
}

pub fn skip_entry(host: &HostContext, args: &[Value]) -> Result<Value> {
    let (id, entry_id) = (text(args, 0)?, text(args, 1)?);
    decided(host, runtime::block_on(runner(host).skip_entry(id, entry_id)))
}

pub fn retry_entry(host: &HostContext, args: &[Value]) -> Result<Value> {
    let (id, entry_id) = (text(args, 0)?, text(args, 1)?);
    decided(host, runtime::block_on(runner(host).retry_entry(id, entry_id)))
}

pub fn approve_gate(host: &HostContext, args: &[Value]) -> Result<Value> {
    let (id, entry_id) = (text(args, 0)?, text(args, 1)?);
    decided(host, runtime::block_on(runner(host).approve_gate(id, entry_id)))
}

pub fn set_armed(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let armed = args.get(1).and_then(Value::as_bool).ok_or_else(|| failure("armed boolean required"))?;
    let run = require_run(host, id)?;
    let at = now();
    let modified = if armed {
        arm_scheduled_run(run, &at).map_err(failure)?
    } else {
        hold_scheduled_run(run, &at).map_err(failure)?
    };
    let saved = save_run(host, modified).map_err(failure)?;
    changed(host);
    Ok(view_of(host, &saved))
}

pub fn resolve_missed(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let resolution = match text(args, 1)? {
        "skip" => MissedResolution::Skip,
        "start-now" => MissedResolution::StartNow,
        other => return Err(failure(format!("Invalid missed resolution: {other}"))),
    };
    let run = require_run(host, id)?;
    let modified = resolve_missed_scheduled_run(run, resolution, &now()).map_err(failure)?;
    let saved = save_run(host, modified).map_err(failure)?;
    changed(host);
    // "Start now" means now: do not wait for the next tick.
    if resolution == MissedResolution::StartNow {
        scheduled_runner_host::tick_now(host);
    }
    Ok(view_of(host, &saved))
}

pub fn dispatch(host: &HostContext, channel: &str, args: &[Value]) -> Result<Value> {
    match channel {
        "scheduledRuns:list" => list(host),
        "scheduledRuns:get" => get(host, args),
        "scheduledRuns:save" => save(host, args),
        "scheduledRuns:preview" => preview(host, args),
        "scheduledRuns:remove" => remove(host, args),
        "scheduledRuns:rename" => rename(host, args),
        "scheduledRuns:archive" => archive(host, args),
        "scheduledRuns:workflowChoices" => workflow_choices(host, args),
        "scheduledRuns:pause" => pause(host, args),
        "scheduledRuns:startNow" => start_now(host, args),
        "scheduledRuns:resume" => resume(host, args),
        "scheduledRuns:cancel" => cancel(host, args),
        "scheduledRuns:skipEntry" => skip_entry(host, args),
        "scheduledRuns:retryEntry" => retry_entry(host, args),
        "scheduledRuns:approveGate" => approve_gate(host, args),
        "scheduledRuns:setArmed" => set_armed(host, args),
        "scheduledRuns:resolveMissed" => resolve_missed(host, args),
        _ => Err(failure(format!("Unsupported scheduled-runs channel: {channel}"))),
    }
}
