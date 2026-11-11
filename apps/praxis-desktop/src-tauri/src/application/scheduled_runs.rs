//! Scheduled runs in-process store and lifecycle commands.

use std::fs;
use std::path::PathBuf;

use chrono::{SecondsFormat, Utc};
use praxis_host::HostContext;
use praxis_workflows::scheduled_run::{
    ComposeScheduledRunInput, MissedResolution, ScheduledEntryOutcome, ScheduledEntryStatus,
    ScheduledPauseReason, ScheduledRun, ScheduledRunAttempt, ScheduledRunPause, ScheduledRunStatus,
    ScheduledRunTrigger, ScheduledTicketRef, arm_scheduled_run, compose_scheduled_run,
    hold_scheduled_run, resolve_missed_scheduled_run,
};
use praxis_workflows::scheduled_run_readiness::{
    ScheduledReadinessContext, ScheduledTicketProbe, ScheduledTicketProbeSource,
    assess_scheduled_run_readiness,
};
use praxis_workflows::scheduled_run_store::{RUNS_KEY, ScheduledRunBackend, ScheduledRunStore};
use praxis_workflows::scheduled_run_time::instant_to_zoned_parts;
use serde_json::{Value, json};

use super::storage;
use super::{Result, failure, text};

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

struct DefaultProbeSource;

impl ScheduledTicketProbeSource for DefaultProbeSource {
    fn probe(&self, _ticket: &ScheduledTicketRef) -> ScheduledTicketProbe {
        ScheduledTicketProbe::found()
    }
}

fn scheduled_runs_path(host: &HostContext) -> PathBuf {
    host.config().user_data_dir.join("scheduled-runs.json")
}

fn store(host: &HostContext) -> ScheduledRunStore<JsonFileBackend> {
    ScheduledRunStore::new(JsonFileBackend {
        path: scheduled_runs_path(host),
    })
}

fn build_view(run: &ScheduledRun, _all_runs: &[ScheduledRun], now_str: &str) -> Value {
    let probe = DefaultProbeSource;
    let context = ScheduledReadinessContext {
        now: now_str.into(),
        probe: &probe,
        usable_provider_count: 1,
        workflow_trusted: Some(true),
        base_dirty: false,
        low_allowance_provider: None,
    };
    let readiness = assess_scheduled_run_readiness(run, &context);
    let start = instant_to_zoned_parts(&run.scheduled_start_at, &run.timezone).unwrap_or(
        praxis_workflows::scheduled_run_time::ZonedParts {
            date: "".into(),
            time: "".into(),
        },
    );

    json!({
        "run": run,
        "readiness": readiness,
        "start": { "date": start.date, "time": start.time },
    })
}

fn parse_ticket_refs(val: Option<&Value>) -> Vec<ScheduledTicketRef> {
    val.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let obj = item.as_object()?;
                    let connection_id = obj.get("connectionId")?.as_str()?.to_string();
                    let issue_key = obj.get("issueKey")?.as_str()?.to_string();
                    let title = obj
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or(&issue_key)
                        .to_string();
                    Some(ScheduledTicketRef {
                        connection_id,
                        issue_key,
                        title,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_string_list(val: Option<&Value>) -> Vec<String> {
    val.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn list(host: &HostContext) -> Result<Value> {
    let runs = store(host).list();
    let current_now = now();
    let views: Vec<Value> = runs
        .iter()
        .map(|run| build_view(run, &runs, &current_now))
        .collect();
    Ok(json!(views))
}

pub fn get(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let runs = store(host).list();
    let current_now = now();
    let view = runs
        .iter()
        .find(|r| r.id == id)
        .map(|r| build_view(r, &runs, &current_now));
    Ok(json!(view))
}

pub fn save(host: &HostContext, args: &[Value]) -> Result<Value> {
    let input = args
        .first()
        .ok_or_else(|| failure("save requires input object"))?;
    let mut store = store(host);
    let id = input.get("id").and_then(Value::as_str);
    let existing = id.and_then(|id_str| store.get(id_str));
    let start_now = input
        .get("startNow")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let name = input
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Scheduled run")
        .to_string();
    let date = input
        .get("date")
        .and_then(Value::as_str)
        .unwrap_or("2026-11-11")
        .to_string();
    let time = input
        .get("time")
        .and_then(Value::as_str)
        .unwrap_or("22:00")
        .to_string();
    let timezone = input
        .get("timezone")
        .and_then(Value::as_str)
        .unwrap_or("UTC")
        .to_string();
    let tickets = parse_ticket_refs(input.get("tickets"));
    let with_previous = parse_string_list(input.get("withPrevious"));
    let workflow_id = input
        .get("workflowId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let max_concurrency = input.get("maxConcurrency").and_then(Value::as_i64);
    let arm = input.get("arm").and_then(Value::as_bool).unwrap_or(false);
    let project_id = input
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_string);

    let current_now = now();
    let compose_input = ComposeScheduledRunInput {
        project_id,
        name,
        date,
        time,
        timezone,
        tickets,
        with_previous,
        workflow_id,
        max_concurrency,
        arm,
        at: current_now.clone(),
    };

    let mut run = compose_scheduled_run(existing, compose_input).map_err(failure)?;

    if start_now {
        run.status = ScheduledRunStatus::Running;
        run.attempts.push(ScheduledRunAttempt {
            id: uuid::Uuid::new_v4().to_string(),
            trigger: ScheduledRunTrigger::StartNow,
            started_at: current_now.clone(),
            ended_at: None,
        });
    }

    let saved = store.save(run).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);

    let all_runs = store.list();
    Ok(build_view(&saved, &all_runs, &current_now))
}

pub fn preview(_host: &HostContext, args: &[Value]) -> Result<Value> {
    let input = args
        .first()
        .ok_or_else(|| failure("preview requires input object"))?;
    let name = input
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Scheduled run")
        .to_string();
    let date = input
        .get("date")
        .and_then(Value::as_str)
        .unwrap_or("2026-11-11")
        .to_string();
    let time = input
        .get("time")
        .and_then(Value::as_str)
        .unwrap_or("22:00")
        .to_string();
    let timezone = input
        .get("timezone")
        .and_then(Value::as_str)
        .unwrap_or("UTC")
        .to_string();
    let tickets = parse_ticket_refs(input.get("tickets"));
    let with_previous = parse_string_list(input.get("withPrevious"));
    let workflow_id = input
        .get("workflowId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let max_concurrency = input.get("maxConcurrency").and_then(Value::as_i64);
    let project_id = input
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_string);

    let current_now = now();
    let compose_input = ComposeScheduledRunInput {
        project_id,
        name,
        date,
        time,
        timezone,
        tickets,
        with_previous,
        workflow_id,
        max_concurrency,
        arm: false,
        at: current_now.clone(),
    };

    let run = match compose_scheduled_run(None, compose_input) {
        Ok(run) => run,
        Err(err) => return Ok(json!({ "error": err })),
    };

    let probe = DefaultProbeSource;
    let context = ScheduledReadinessContext {
        now: current_now,
        probe: &probe,
        usable_provider_count: 1,
        workflow_trusted: Some(true),
        base_dirty: false,
        low_allowance_provider: None,
    };
    let readiness = assess_scheduled_run_readiness(&run, &context);
    Ok(json!({ "readiness": readiness }))
}

pub fn remove(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let mut store = store(host);
    store.remove(id).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    Ok(Value::Null)
}

pub fn rename(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let name = text(args, 1)?;
    let mut store = store(host);
    let current_now = now();
    let updated = store.rename(id, name, &current_now).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
}

pub fn archive(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let archived = args
        .get(1)
        .and_then(Value::as_bool)
        .ok_or_else(|| failure("archived boolean required"))?;
    let mut store = store(host);
    let current_now = now();
    let updated = store
        .set_archived(id, archived, &current_now)
        .map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
}

pub fn workflow_choices(_host: &HostContext, _args: &[Value]) -> Result<Value> {
    Ok(json!({
        "choices": [
            {
                "id": "governed-delivery",
                "name": "Governed delivery",
                "description": "Plan, implement, review, and test with human sign-off."
            },
            {
                "id": "quick-change",
                "name": "Quick change",
                "description": "Streamlined single-stage automated checks."
            }
        ],
        "defaultWorkflowId": "governed-delivery"
    }))
}

pub fn pause(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let mut store = store(host);
    let current_now = now();
    let mut run = store
        .get(id)
        .ok_or_else(|| failure(format!("Run {id} not found")))?;
    run.status = ScheduledRunStatus::Paused;
    run.pause = Some(ScheduledRunPause {
        reason: ScheduledPauseReason::User,
        entry_id: None,
        message: "Paused by user".into(),
        at: current_now.clone(),
    });
    let updated = store.save(run).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
}

pub fn start_now(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let mut store = store(host);
    let current_now = now();
    let mut run = store
        .get(id)
        .ok_or_else(|| failure(format!("Run {id} not found")))?;
    run.status = ScheduledRunStatus::Running;
    run.attempts.push(ScheduledRunAttempt {
        id: uuid::Uuid::new_v4().to_string(),
        trigger: ScheduledRunTrigger::StartNow,
        started_at: current_now.clone(),
        ended_at: None,
    });
    let updated = store.save(run).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
}

pub fn resume(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let mut store = store(host);
    let current_now = now();
    let mut run = store
        .get(id)
        .ok_or_else(|| failure(format!("Run {id} not found")))?;
    run.status = ScheduledRunStatus::Running;
    run.pause = None;
    let updated = store.save(run).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
}

pub fn cancel(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let mut store = store(host);
    let current_now = now();
    let mut run = store
        .get(id)
        .ok_or_else(|| failure(format!("Run {id} not found")))?;
    run.status = ScheduledRunStatus::Cancelled;
    let updated = store.save(run).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
}

pub fn skip_entry(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let entry_id = text(args, 1)?;
    let mut store = store(host);
    let current_now = now();
    let mut run = store
        .get(id)
        .ok_or_else(|| failure(format!("Run {id} not found")))?;
    for entry in &mut run.entries {
        if entry.id == entry_id {
            entry.outcome = Some(ScheduledEntryOutcome {
                status: ScheduledEntryStatus::Skipped,
                ended_at: Some(current_now.clone()),
                reason: Some("Skipped by user".into()),
                ..ScheduledEntryOutcome::queued()
            });
            break;
        }
    }
    let updated = store.save(run).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
}

pub fn retry_entry(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let entry_id = text(args, 1)?;
    let mut store = store(host);
    let current_now = now();
    let mut run = store
        .get(id)
        .ok_or_else(|| failure(format!("Run {id} not found")))?;
    for entry in &mut run.entries {
        if entry.id == entry_id {
            entry.outcome = Some(ScheduledEntryOutcome::queued());
            break;
        }
    }
    let updated = store.save(run).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
}

pub fn approve_gate(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let entry_id = text(args, 1)?;
    let mut store = store(host);
    let current_now = now();
    let mut run = store
        .get(id)
        .ok_or_else(|| failure(format!("Run {id} not found")))?;
    for entry in &mut run.entries {
        if entry.id == entry_id {
            if let Some(outcome) = &mut entry.outcome {
                outcome.gate = None;
            }
            break;
        }
    }
    let updated = store.save(run).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
}

pub fn set_armed(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let armed = args
        .get(1)
        .and_then(Value::as_bool)
        .ok_or_else(|| failure("armed boolean required"))?;
    let mut store = store(host);
    let current_now = now();
    let run = store
        .get(id)
        .ok_or_else(|| failure(format!("Run {id} not found")))?;
    let modified = if armed {
        arm_scheduled_run(run, &current_now).map_err(failure)?
    } else {
        hold_scheduled_run(run, &current_now).map_err(failure)?
    };
    let updated = store.save(modified).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
}

pub fn resolve_missed(host: &HostContext, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let res_str = text(args, 1)?;
    let resolution = match res_str {
        "skip" => MissedResolution::Skip,
        "start-now" => MissedResolution::StartNow,
        _ => return Err(failure(format!("Invalid missed resolution: {res_str}"))),
    };
    let mut store = store(host);
    let current_now = now();
    let run = store
        .get(id)
        .ok_or_else(|| failure(format!("Run {id} not found")))?;
    let modified = resolve_missed_scheduled_run(run, resolution, &current_now).map_err(failure)?;
    let updated = store.save(modified).map_err(failure)?;
    host.events().emit("scheduledRuns:changed", None);
    let all_runs = store.list();
    Ok(build_view(&updated, &all_runs, &current_now))
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
        _ => Err(failure(format!(
            "Unsupported scheduledRuns channel: {channel}"
        ))),
    }
}
