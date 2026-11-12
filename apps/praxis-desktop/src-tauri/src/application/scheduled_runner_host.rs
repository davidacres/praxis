//! Wires the scheduled-run runner to the real app (`scheduledRunRunnerInstance.ts`,
//! `scheduledRunLive.ts` port): the schedule store, the workflow engine, provider usage and the
//! clock. The decisions live in `praxis_workflows::scheduled_run_runner`; this file only supplies
//! its ports.
//!
//! Launching goes through [`workflows::start_workflow_run`], the same path the phone and the
//! designer use, so trust, validation, preflight, provider checks and the clean-base check all
//! apply. An unattended start never answers a question on the user's behalf: a dirty base or an
//! unapproved workflow pauses the schedule and says why.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use praxis_contracts::{ProjectWorkflowStage, RustRpcRequest, WorkflowTransition};
use praxis_host::HostContext;
use praxis_workflows::edges::{loop_budget, pending_loop};
use praxis_workflows::gates::{
    approval_readiness, approve_stage, failing_gate_findings, reject_stage,
    repair_stage_for_findings, resolve_approval_target, skip_approval,
};
use praxis_workflows::run::{
    LoopDecisionKind, ReworkOptions, WorkflowPauseReason, WorkflowRun, WorkflowRunCommand,
    apply_workflow_run_command, exhausted_providers, rework_workflow_run,
};
use praxis_workflows::scheduled_budget::ProviderUsage;
use praxis_workflows::scheduled_run::{ScheduledPauseReason, ScheduledRun, ScheduledTicketRef};
use praxis_workflows::scheduled_run_execution::{
    EntryProgress, EntryProgressKind, StageRecovery,
};
use praxis_workflows::scheduled_run_runner::{
    ProviderUsageReading, ScheduledGateDecisionResult, ScheduledHandOverRequest,
    ScheduledHandOverResult, ScheduledLaunchError, ScheduledLaunchRequest, ScheduledLaunched,
    ScheduledLoopDecisionResult, ScheduledMoveTicketRequest, ScheduledRunRunner,
    ScheduledRunnerPorts, WorkflowObservation,
};
use praxis_workflows::scheduled_ticket_status::scheduled_ticket_transition;
use praxis_workflows::types::WORKFLOW_MAX_LOOP_ITERATIONS;
use serde_json::{Value, json};

use super::scheduled_runs;
use super::workflows::{self, StartRunInput};
use super::{runtime, workflow_engine};

const ACTOR: &str = "Scheduled run (autonomous)";

fn tick_interval() -> Duration {
    let ms = std::env::var("PRAXIS_E2E_SCHEDULE_TICK_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(30_000);
    Duration::from_millis(ms)
}

fn launch_reason(message: &str) -> Option<ScheduledPauseReason> {
    let lower = message.to_lowercase();
    if lower.contains("workspace trust") {
        Some(ScheduledPauseReason::Trust)
    } else if lower.contains("not set up or turned off") || lower.contains("no ai provider") {
        Some(ScheduledPauseReason::NoProvider)
    } else {
        Some(ScheduledPauseReason::Policy)
    }
}

struct HostPorts {
    host: HostContext,
}

impl HostPorts {
    /// Calls a board channel the way the renderer would. Runs off the async workers, because the
    /// handlers it reaches block.
    async fn rpc(&self, channel: &str, args: Vec<Value>) -> Result<Value, String> {
        let host = self.host.clone();
        let channel = channel.to_string();
        tokio::task::spawn_blocking(move || {
            let response = host.dispatch_rpc(RustRpcRequest {
                id: "scheduled-run".into(),
                channel,
                args,
            });
            if response.ok {
                Ok(response.result.unwrap_or(Value::Null))
            } else {
                Err(response
                    .error
                    .map_or_else(|| "The host returned no error.".to_string(), |e| e.message))
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }

    fn run(&self, id: &str) -> Option<WorkflowRun> {
        workflows::stored_run(&self.host, id)
    }

    async fn update_run<F>(&self, id: &str, change: F) -> Result<(), String>
    where
        F: FnOnce(WorkflowRun) -> WorkflowRun + Send + 'static,
    {
        workflow_engine::engine(&self.host)
            .orchestrator()
            .update_run(id, change)
            .await
    }

    fn usable_providers(&self) -> Vec<String> {
        usable_providers(&self.host)
    }
}

/// Providers that are enabled and set up, in preference order.
pub fn usable_providers(host: &HostContext) -> Vec<String> {
    let settings = host.settings().read();
    let ai = &settings.ai;
    let mut usable: Vec<String> = Vec::new();
    for descriptor in praxis_ai::providers::registry::built_in_descriptors() {
        let config = ai.providers.get(&descriptor.id);
        if config.and_then(|c| c.enabled) == Some(false) {
            continue;
        }
        let set_up = match descriptor.kind {
            praxis_ai::providers::registry::DescriptorKind::Api => {
                host.secrets()
                    .has(&praxis_ai::providers::registry::secret_key_for_provider(&descriptor.id))
                    || (descriptor.id == "vercel-gateway"
                        && praxis_ai::providers::registry::gateway_key_from_env().is_some())
            }
            praxis_ai::providers::registry::DescriptorKind::CliAgent => {
                // A CLI agent counts once it has been pointed at (or chosen as the active AI); one that
                // merely happens to be installed on this machine is not set up for Praxis.
                config.and_then(|c| c.cli_path.as_deref()).map(str::trim).is_some_and(|p| {
                    !p.is_empty()
                        && praxis_workflows::check_process::is_check_command_available(
                            p,
                            std::env::var("PATH").ok().as_deref(),
                            std::env::var("PATHEXT").ok().as_deref(),
                        )
                })
                    || (descriptor.id == ai.active_provider
                        && descriptor.default_command.as_deref().is_some_and(|command| {
                            praxis_workflows::check_process::is_check_command_available(
                                command,
                                std::env::var("PATH").ok().as_deref(),
                                std::env::var("PATHEXT").ok().as_deref(),
                            )
                        }))
            }
        };
        if set_up {
            usable.push(descriptor.id);
        }
    }
    // Endpoints the user added: usable unless switched off, with a key unless they need none.
    for custom in ai.custom_providers.iter().flatten().filter_map(|c| serde_json::to_value(c).ok()) {
        let Some(id) = custom["id"].as_str() else { continue };
        if ai.providers.get(id).and_then(|c| c.enabled) == Some(false) || custom["enabled"] == json!(false) {
            continue;
        }
        let needs_key = custom["auth"]["kind"] != "none";
        if !needs_key || host.secrets().has(&praxis_ai::providers::registry::secret_key_for_provider(id)) {
            usable.push(id.to_string());
        }
    }
    // The active AI is tried first, then the rest in registry order.
    let active = ai.active_provider.clone();
    if let Some(index) = usable.iter().position(|id| *id == active) {
        let preferred = usable.remove(index);
        usable.insert(0, preferred);
    }
    usable
}

/// An e2e stand-in for provider quotas: `{"claude-code-cli":0.97}` is the fraction of allowance used.
pub fn usage_override() -> Option<std::collections::BTreeMap<String, f64>> {
    let live = E2E_USAGE.lock().ok().and_then(|raw| raw.clone());
    live.or_else(|| std::env::var("PRAXIS_E2E_PROVIDER_USAGE").ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

/// Test seam (e2e server only): replaces the usage override while the process runs, since a
/// separate backend process cannot have its environment changed mid-test.
static E2E_USAGE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn set_usage_override(raw: Option<String>) {
    if let Ok(mut live) = E2E_USAGE.lock() {
        *live = raw;
    }
}

/// An entry's agent tasks in run order, with state, attempts and time (`scheduledEntryDetail`).
pub fn entry_detail(host: &HostContext, entry_id: &str, run: &WorkflowRun) -> Value {
    let summary = workflows::summarize(host, run);
    let rows = summary["stages"].as_array().cloned().unwrap_or_default();
    let ordered = praxis_workflows::scheduled_run_detail::ordered_workflow_stages(&run.definition, |id| {
        run.nodes.get(id).is_some_and(|n| !n.attempts.is_empty())
    });
    let mut stages = Vec::new();
    for node in ordered {
        let id = &node.base().id;
        let Some(row) = rows.iter().find(|r| r["nodeId"] == json!(id)) else { continue };
        let total_ms: i64 = run
            .nodes
            .get(id)
            .map(|state| {
                state
                    .attempts
                    .iter()
                    .filter_map(|a| {
                        let end = chrono::DateTime::parse_from_rfc3339(a.ended_at.as_deref()?).ok()?;
                        let start = chrono::DateTime::parse_from_rfc3339(&a.started_at).ok()?;
                        Some((end - start).num_milliseconds().max(0))
                    })
                    .sum()
            })
            .unwrap_or(0);
        let mut stage = serde_json::Map::new();
        for key in [
            "nodeId", "name", "type", "lane", "attempts", "attemptsThisRevision", "maxAttempts", "provider",
            "durationMs", "startedAt", "lastError", "command", "sessionKey",
        ] {
            if let Some(value) = row.get(key).filter(|v| !v.is_null()) {
                stage.insert(key.to_string(), value.clone());
            }
        }
        if total_ms > 0 {
            stage.insert("totalMs".into(), json!(total_ms));
        }
        if let Some(iteration) = row["loopIteration"]["iteration"].as_u64().filter(|i| *i > 1) {
            stage.insert("loopIteration".into(), json!(iteration));
        }
        if row["lane"] == "paused" {
            if let Some(error) = row["lastError"].as_str() {
                stage.insert("activity".into(), json!({ "text": error, "source": "pause" }));
            }
        }
        stages.push(Value::Object(stage));
    }
    let mut loops = Vec::new();
    for lp in summary["loops"].as_array().into_iter().flatten() {
        for pass in lp["history"].as_array().into_iter().flatten() {
            let findings: Vec<String> = pass["topFindings"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|f| {
                    let place = f["file"]
                        .as_str()
                        .map(|file| match f["line"].as_u64() {
                            Some(line) => format!(" · {file}:{line}"),
                            None => format!(" · {file}"),
                        })
                        .unwrap_or_default();
                    format!("{}{place} — {}", f["severity"].as_str().unwrap_or(""), f["message"].as_str().unwrap_or(""))
                })
                .collect();
            loops.push(json!({
                "fromName": lp["fromName"], "toName": lp["toName"], "iteration": pass["iteration"],
                "at": pass["at"], "findings": findings,
            }));
        }
    }
    json!({ "entryId": entry_id, "workflowRunId": run.run_id, "stages": stages, "loops": loops })
}

/// Details for every started entry of a schedule that is in flight or finished.
pub fn entry_details(host: &HostContext, run: &ScheduledRun) -> Vec<Value> {
    run.entries
        .iter()
        .filter_map(|entry| {
            let workflow_run_id = entry.outcome.as_ref()?.workflow_run_id.clone()?;
            let stored = workflows::stored_run(host, &workflow_run_id)?;
            Some(entry_detail(host, &entry.id, &stored))
        })
        .collect()
}

/// One record per in-flight entry, with its run's stage progress (`describeLiveEntries`).
pub fn live_entries(host: &HostContext, run: &ScheduledRun) -> Vec<Value> {
    run.entries
        .iter()
        .filter_map(|entry| {
            let outcome = entry.outcome.as_ref()?;
            let status = serde_json::to_value(outcome.status).ok()?;
            if !matches!(status.as_str(), Some("running" | "paused" | "failed")) {
                return None;
            }
            let workflow_run_id = outcome.workflow_run_id.clone()?;
            let mut live = json!({ "entryId": entry.id, "workflowRunId": workflow_run_id });
            match workflows::stored_run(host, &workflow_run_id) {
                Some(stored) => {
                    live["stages"] = entry_detail(host, &entry.id, &stored)["stages"].clone();
                    let progress = stage_progress(host, &stored);
                    if let (Some(target), Some(source)) = (live.as_object_mut(), progress.as_object()) {
                        target.extend(source.clone());
                    }
                }
                None => {
                    live["stageLabel"] = json!("Starting");
                    live["stageIndex"] = json!(0);
                    live["stageCount"] = json!(0);
                }
            }
            Some(live)
        })
        .collect()
}

fn stage_progress(host: &HostContext, run: &WorkflowRun) -> Value {
    let summary = workflows::summarize(host, run);
    let stages = summary["stages"].as_array().cloned().unwrap_or_default();
    let working = stages
        .iter()
        .any(|s| matches!(s["lane"].as_str(), Some("running" | "ready")));
    let blocker = if summary["status"] == "running"
        && summary.get("needsDecision").is_none_or(Value::is_null)
        && !working
    {
        stages.iter().find(|s| s["lane"] == "failed").cloned()
    } else if summary["status"] == "failed" {
        stages.iter().find(|s| s["lane"] == "failed").cloned()
    } else {
        None
    };
    // Held at a stage by its environment (a missing tool, a working copy that could not be set up),
    // with nothing failed outright: that stage is the one to retry.
    let blocker = blocker.or_else(|| {
        (summary["paused"] == json!(true) && summary["pauseReason"] == "environment")
            .then(|| {
                stages
                    .iter()
                    .find(|s| s["lane"] == "paused" && s["pause"] == "environment")
                    .cloned()
            })
            .flatten()
    });
    let current = blocker
        .clone()
        .or_else(|| {
            stages
                .iter()
                .find(|s| matches!(s["lane"].as_str(), Some("running" | "awaiting" | "paused")))
                .cloned()
        })
        .or_else(|| stages.iter().find(|s| s["lane"] == "failed").cloned());
    let done = stages
        .iter()
        .filter(|s| matches!(s["lane"].as_str(), Some("done" | "skipped")))
        .count();
    let label = match &current {
        Some(stage) => format!(
            "{}{}",
            stage["name"].as_str().unwrap_or(""),
            if stage["outcome"] == "failed" { " — needs attention" } else { "" }
        ),
        None if summary["status"] == "succeeded" => "Finished".to_string(),
        None => summary["explanation"].as_str().unwrap_or("").to_string(),
    };
    let index = current
        .as_ref()
        .and_then(|c| stages.iter().position(|s| s["nodeId"] == c["nodeId"]))
        .map_or(done, |p| p + 1);
    let mut progress = json!({ "stageLabel": label, "stageIndex": index, "stageCount": stages.len() });
    if let Some(stage) = &blocker {
        progress["recovery"] = json!({
            "nodeId": stage["nodeId"],
            "error": stage["lastError"],
            "attempts": stage.get("attemptsThisRevision").unwrap_or(&stage["attempts"]),
            "maxAttempts": stage["maxAttempts"],
        });
    }
    if let Some(provider) = current.as_ref().and_then(|c| c["provider"].as_str()) {
        progress["provider"] = json!(provider);
    }
    progress
}

/// Advance the schedules right now instead of waiting for the next tick.
pub fn tick_now(host: &HostContext) {
    let active = Arc::clone(runner(host));
    runtime::runtime().spawn(async move { active.tick().await });
}

/// What the workflow engine says about a run, reduced to what the schedule acts on.
fn observe_run(host: &HostContext, run: &WorkflowRun) -> WorkflowObservation {
    let summary = workflows::summarize(host, run);
    let stages = summary["stages"].as_array().cloned().unwrap_or_default();
    let status = summary["status"].as_str().unwrap_or("");
    let explanation = summary["explanation"].as_str().unwrap_or("").to_string();
    let exhausted = exhausted_providers(run);
    let any_active = stages
        .iter()
        .any(|s| matches!(s["lane"].as_str(), Some("running" | "ready")));
    let looping = summary["loops"]
        .as_array()
        .is_some_and(|l| l.iter().any(|x| x["firing"] == json!(true) && x["needsDecision"] != json!(true)));
    let blocker = (status == "running"
        && summary.get("needsDecision").is_none_or(Value::is_null)
        && !any_active
        && !looping)
        .then(|| stages.iter().find(|s| s["lane"] == "failed").cloned())
        .flatten();
    let kind = match status {
        "succeeded" => EntryProgressKind::Succeeded { spend: None, exhausted },
        "failed" => {
            let failing = stages.iter().find(|s| s["outcome"] == "failed");
            EntryProgressKind::Failed {
                reason: failing
                    .and_then(|s| s["lastError"].as_str())
                    .filter(|e| !e.is_empty())
                    .map_or(explanation, str::to_string),
                node_id: failing.and_then(|s| s["nodeId"].as_str()).map(str::to_string),
                spend: None,
                exhausted,
            }
        }
        "cancelled" => EntryProgressKind::Cancelled { reason: explanation, spend: None, exhausted },
        _ if summary["paused"] == json!(true) => {
            let stuck = (blocker.is_none() && summary["pauseReason"] == "environment")
                .then(|| {
                    stages
                        .iter()
                        .find(|s| s["lane"] == "paused" && s["pause"] == "environment")
                        .cloned()
                })
                .flatten();
            match stuck {
                Some(stage) => {
                    let name = stage["name"].as_str().unwrap_or("");
                    let error = stage["lastError"].as_str().unwrap_or("");
                    let interrupted = error.contains("Interrupted — the app stopped while this stage was running.");
                    EntryProgressKind::Stalled {
                        reason: if interrupted {
                            format!("{name} was interrupted when Praxis stopped. It will retry automatically when Praxis starts.")
                        } else {
                            format!("{name} could not run here: {} Fix that, then retry the stage.", if error.is_empty() { explanation.as_str() } else { error })
                        },
                        pause_reason: ScheduledPauseReason::Failure,
                        edge_id: None,
                        recovery: Some(StageRecovery {
                            node_id: stage["nodeId"].as_str().unwrap_or("").to_string(),
                            attempts: stage["attemptsThisRevision"].as_u64().or(stage["attempts"].as_u64()).unwrap_or(1) as u32,
                            max_attempts: stage["maxAttempts"].as_u64().unwrap_or(1) as u32,
                            automatic: Some(interrupted),
                        }),
                        spend: None,
                        exhausted,
                    }
                }
                None => EntryProgressKind::Stalled {
                    reason: explanation,
                    pause_reason: if summary["pauseReason"] == "provider-limit" {
                        ScheduledPauseReason::Budget
                    } else {
                        ScheduledPauseReason::Policy
                    },
                    edge_id: None,
                    recovery: None,
                    spend: None,
                    exhausted,
                },
            }
        }
        "awaiting-approval" => {
            let node_id = resolve_approval_target(run, None)
                .map(|a| a.base.id.clone())
                .unwrap_or_default();
            let label = stages
                .iter()
                .find(|s| s["nodeId"] == json!(node_id))
                .and_then(|s| s["name"].as_str())
                .unwrap_or("Approval")
                .to_string();
            EntryProgressKind::Gate { node_id, label, spend: None, exhausted }
        }
        _ if blocker.is_some() => {
            let stage = blocker.unwrap_or(Value::Null);
            EntryProgressKind::Stalled {
                reason: format!(
                    "{} failed: {} Retry the stage or open the workflow to review it.",
                    stage["name"].as_str().unwrap_or(""),
                    stage["lastError"].as_str().unwrap_or("No error was reported.")
                ),
                pause_reason: ScheduledPauseReason::Failure,
                edge_id: None,
                recovery: Some(StageRecovery {
                    node_id: stage["nodeId"].as_str().unwrap_or("").to_string(),
                    attempts: stage["attemptsThisRevision"].as_u64().or(stage["attempts"].as_u64()).unwrap_or(1) as u32,
                    max_attempts: stage["maxAttempts"].as_u64().unwrap_or(1) as u32,
                    automatic: None,
                }),
                spend: None,
                exhausted,
            }
        }
        _ if summary.get("needsDecision").is_some_and(|d| !d.is_null()) => EntryProgressKind::Stalled {
            reason: summary["needsDecision"]["message"].as_str().unwrap_or("").to_string(),
            pause_reason: ScheduledPauseReason::Policy,
            edge_id: summary["needsDecision"]["edgeId"].as_str().map(str::to_string),
            recovery: None,
            spend: None,
            exhausted,
        },
        _ => {
            let live = stages
                .iter()
                .find(|s| s["lane"] == "running")
                .or_else(|| stages.iter().rev().find(|s| s.get("provider").is_some_and(|p| !p.is_null())));
            EntryProgressKind::Running {
                provider: live
                    .and_then(|s| s["provider"].as_str())
                    .or(summary["aiProvider"].as_str())
                    .map(str::to_string),
                session_id: live.and_then(|s| s["sessionId"].as_str()).map(str::to_string),
                spend: None,
                exhausted,
            }
        }
    };
    let artifacts = run.nodes.values().flat_map(|n| n.artifacts.clone()).collect();
    WorkflowObservation {
        progress: EntryProgress { kind, estimate: None, artifacts },
        idle: None,
    }
}

#[async_trait]
impl ScheduledRunnerPorts for HostPorts {
    async fn list(&self) -> Vec<ScheduledRun> {
        scheduled_runs::list_runs(&self.host)
    }

    fn get(&self, id: &str) -> Option<ScheduledRun> {
        scheduled_runs::get_run(&self.host, id)
    }

    async fn save(&self, run: ScheduledRun) -> Result<ScheduledRun, String> {
        scheduled_runs::save_run(&self.host, run)
    }

    fn now(&self) -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn is_enabled(&self) -> bool {
        true
    }

    fn new_token(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn observe(&self, workflow_run_id: &str) -> Option<WorkflowObservation> {
        self.run(workflow_run_id).map(|run| observe_run(&self.host, &run))
    }

    fn find_by_launch_token(&self, token: &str) -> Option<String> {
        workflows::all_runs(&self.host)
            .into_iter()
            .find(|run| run.scheduled_launch_token.as_deref() == Some(token))
            .map(|run| run.run_id)
    }

    async fn check_ticket(&self, ticket: &ScheduledTicketRef) -> Result<Option<String>, String> {
        match self
            .rpc("issue:get", vec![json!(ticket.issue_key), json!(ticket.connection_id)])
            .await
        {
            Ok(issue) => Ok(issue["statusCategory"]
                .as_str()
                .is_some_and(|c| c.eq_ignore_ascii_case("done"))
                .then(|| format!("{} is already finished.", ticket.issue_key))),
            Err(_) => Ok(Some(format!(
                "{} no longer exists or can no longer be read.",
                ticket.issue_key
            ))),
        }
    }

    async fn launch(
        &self,
        request: ScheduledLaunchRequest,
    ) -> Result<ScheduledLaunched, ScheduledLaunchError> {
        let ScheduledLaunchRequest { run, entry, workflow_id, token, provider, delivery_branch_name, final_entry } = request;
        let Some(project_id) = run.project_id.clone() else {
            return Err(ScheduledLaunchError::with_reason(
                "This schedule is not tied to a project, so it has nowhere to run the tickets.",
                ScheduledPauseReason::Policy,
            ));
        };
        let sequential = matches!(run.policy.mode(), praxis_workflows::scheduled_run::ScheduledRunPolicyMode::Sequential);
        let mut shared = delivery_branch_name.clone();
        if sequential {
            // A ticket whose last attempt failed at its merge resumes on the branch that holds its work.
            if let (Some(folder), Some(_)) = (workflows::project_folder(&self.host, &project_id), shared.as_ref()) {
                let failed = workflows::all_runs(&self.host)
                    .into_iter()
                    .filter(|r| {
                        r.project_id == project_id
                            && r.issue_key.as_deref() == Some(entry.ticket.issue_key.as_str())
                            && serde_json::to_value(r.status).ok() == Some(json!("failed"))
                            && r.nodes.get("merge").is_some_and(|n| serde_json::to_value(n.outcome).ok() == Some(json!("failed")))
                    })
                    .max_by(|a, b| a.started_at.cmp(&b.started_at));
                if let (Some(root), Some(existing)) = (
                    praxis_core::git::run_work::repository_root(&folder).await,
                    failed,
                ) {
                    if let Some(branch) = praxis_core::git::run_work::find_run_branch(std::path::Path::new(&root), &existing.run_id).await {
                        shared = Some(branch);
                    }
                }
            }
        }
        let mut options = json!({ "permissionMode": "auto", "providerLimitPolicy": "switch" });
        if let Some(provider) = &provider {
            options["aiProvider"] = json!(provider);
        }
        if let Some(branch) = &shared {
            options["sharedDeliveryBranch"] = json!(branch);
        }
        if sequential && !final_entry {
            options["deferMerge"] = json!(true);
        }
        let host = self.host.clone();
        let input = StartRunInput {
            project_id,
            workflow_id,
            task_title: entry.ticket.title.clone(),
            issue_key: Some(entry.ticket.issue_key.clone()),
            issue_connection_id: Some(entry.ticket.connection_id.clone()),
            scheduled_launch_token: Some(token),
            options,
            ..StartRunInput::default()
        };
        let started = tokio::task::spawn_blocking(move || workflows::start_workflow_run(&host, input))
            .await
            .map_err(|e| ScheduledLaunchError::plain(e.to_string()))?;
        match started {
            Ok(run_record) => Ok(ScheduledLaunched {
                workflow_run_id: run_record.run_id,
                delivery_branch_name: if sequential { shared } else { None },
            }),
            Err(error) => Err(ScheduledLaunchError {
                reason: launch_reason(&error.message),
                message: error.message,
            }),
        }
    }

    async fn cancel_workflow(&self, workflow_run_id: &str, reason: &str) -> Result<(), String> {
        workflow_engine::engine(&self.host)
            .orchestrator()
            .cancel(workflow_run_id, Some(reason))
            .await
    }

    async fn usage(&self) -> Result<ProviderUsageReading, String> {
        let usable = self.usable_providers();
        let override_usage = usage_override();
        let mut used = ProviderUsage::new();
        if let Some(map) = &override_usage {
            for provider in &usable {
                if let Some(value) = map.get(provider) {
                    used = used.with(provider.clone(), *value);
                }
            }
        }
        Ok(ProviderUsageReading {
            usable,
            active: Some(self.host.settings().read().ai.active_provider.clone()).filter(|a| !a.is_empty()),
            used,
        })
    }

    fn threshold(&self) -> Option<f64> {
        Some(f64::from(self.host.settings().read().ai.provider_handover_percent) / 100.0)
    }

    async fn hand_over(
        &self,
        request: ScheduledHandOverRequest,
    ) -> Result<ScheduledHandOverResult, String> {
        let ScheduledHandOverRequest { entry, workflow_run_id, from, to, used_fraction, .. } = request;
        let run = self.run(&workflow_run_id).ok_or("The workflow run no longer exists.")?;
        let message = format!(
            "checkpoint: {} at {}% of {from}",
            entry.ticket.issue_key,
            (used_fraction * 100.0).round()
        );
        let mut checkpoint = None;
        if let Some(worktree) = run.worktree_path.as_deref() {
            if praxis_core::git::run_work::preserve_uncommitted_work(std::path::Path::new(worktree), &message).await? {
                checkpoint = tokio::process::Command::new("git")
                    .args(["rev-parse", "--short", "HEAD"])
                    .current_dir(worktree)
                    .output()
                    .await
                    .ok()
                    .filter(|o| o.status.success())
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
            }
        }
        // The run's AI changes for every stage not yet started; each stage launch still checks it can run there.
        let target = to.clone();
        self.update_run(&workflow_run_id, move |mut current| {
            current.ai_provider = Some(target);
            current
        })
        .await?;
        Ok(ScheduledHandOverResult { checkpoint_ref: checkpoint, provider: Some(to) })
    }

    async fn decide_gate(
        &self,
        workflow_run_id: &str,
        node_id: &str,
    ) -> Option<Result<ScheduledGateDecisionResult, String>> {
        let policy = self
            .run(workflow_run_id)
            .and_then(|r| workflows::policy_for(&self.host, &r.project_id));
        let node_id = node_id.to_string();
        let outcome: Arc<std::sync::Mutex<Option<ScheduledGateDecisionResult>>> = Arc::default();
        let slot = Arc::clone(&outcome);
        let result = self
            .update_run(workflow_run_id, move |current| {
                let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let target = (!node_id.is_empty()).then_some(node_id.as_str());
                let Ok(approval) = resolve_approval_target(&current, target) else {
                    return current;
                };
                let id = approval.base.id.clone();
                let optional = approval.optional == Some(true);
                let readiness = approval_readiness(&current, &id, policy.as_ref(), None);
                let set = |decision: &str, reason: String| {
                    *slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
                        Some(ScheduledGateDecisionResult { decision: decision.to_string(), reason });
                };
                if readiness.can_approve {
                    if let Ok(result) = approve_stage(&current, &id, ACTOR, &at, policy.as_ref(), None) {
                        if result.ok {
                            let reason = if readiness.gates.is_empty() {
                                "Auto-approved (no required gates).".to_string()
                            } else {
                                format!(
                                    "Auto-approved: all required gates passed ({}).",
                                    readiness.gates.iter().map(|g| format!("{}: passed", g.gate.as_str())).collect::<Vec<_>>().join(", ")
                                )
                            };
                            set("approved", reason);
                            return result.run;
                        }
                    }
                }
                if optional {
                    if let Ok(skipped) = skip_approval(&current, &id, ACTOR, &at) {
                        if skipped.ok {
                            set(
                                "skipped",
                                format!(
                                    "Optional approval stage skipped because gates were unmet ({}).",
                                    readiness.blocking.iter().map(|g| format!("{}: {}", g.gate.as_str(), g.detail)).collect::<Vec<_>>().join(", ")
                                ),
                            );
                            return skipped.run;
                        }
                    }
                }
                let findings = failing_gate_findings(&current, policy.as_ref(), None);
                let repair = repair_stage_for_findings(&current, &findings);
                let attempts = current.autonomous_rework_attempts.unwrap_or(0);
                if let Some(repair_id) = repair {
                    if !findings.is_empty() && attempts < WORKFLOW_MAX_LOOP_ITERATIONS {
                        let rework = rework_workflow_run(
                            &current,
                            &repair_id,
                            &at,
                            &ReworkOptions { fresh_attempts: true, carry_findings: findings.clone(), ..Default::default() },
                        );
                        if rework.reason.is_none() {
                            set(
                                "reworking",
                                format!("Starting autonomous repair {} of {WORKFLOW_MAX_LOOP_ITERATIONS} from {repair_id} with {} blocking findings.", attempts + 1, findings.len()),
                            );
                            let mut next = rework.run;
                            next.autonomous_rework_attempts = Some(attempts + 1);
                            return next;
                        }
                    }
                }
                let reason = format!(
                    "Gates unmet: {}",
                    readiness.blocking.iter().map(|g| format!("{} {} — {}", g.gate.as_str(), g.state.as_str(), g.detail)).collect::<Vec<_>>().join("; ")
                );
                set("rejected", reason.clone());
                reject_stage(&current, &id, ACTOR, &reason, &at).unwrap_or(current)
            })
            .await;
        if let Err(error) = result {
            return Some(Err(error));
        }
        workflow_engine::engine(&self.host).orchestrator().step(workflow_run_id).await;
        let decided = outcome.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        Some(Ok(decided.unwrap_or(ScheduledGateDecisionResult {
            decision: "rejected".into(),
            reason: "Unable to evaluate approval stage.".into(),
        })))
    }

    async fn decide_loop(
        &self,
        workflow_run_id: &str,
        edge_id: &str,
    ) -> Option<Result<ScheduledLoopDecisionResult, String>> {
        let edge_id = edge_id.to_string();
        let outcome: Arc<std::sync::Mutex<Option<ScheduledLoopDecisionResult>>> = Arc::default();
        let slot = Arc::clone(&outcome);
        let result = self
            .update_run(workflow_run_id, move |current| {
                let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let target = if edge_id.is_empty() {
                    pending_loop(&current).map(|(_, status)| status.edge.id)
                } else {
                    Some(edge_id.clone())
                }
                .unwrap_or_default();
                let edge = current.definition.edges.iter().find(|e| e.id == target);
                let budget = edge.map_or(WORKFLOW_MAX_LOOP_ITERATIONS, |e| loop_budget(&current, e));
                let extra = WORKFLOW_MAX_LOOP_ITERATIONS.saturating_sub(budget);
                let grant = extra > 0;
                let reason = if grant {
                    format!("Autonomous repair: granting the remaining {extra} bounded iteration{} to resolve findings before approval.", if extra == 1 { "" } else { "s" })
                } else {
                    format!("Autonomous repair limit of {WORKFLOW_MAX_LOOP_ITERATIONS} iterations reached with blocking findings still present.")
                };
                let command = WorkflowRunCommand::LoopDecided {
                    edge_id: target,
                    at,
                    actor: ACTOR.to_string(),
                    decision: if grant { LoopDecisionKind::Grant } else { LoopDecisionKind::Stop },
                    reason: Some(reason.clone()),
                    extra_iterations: grant.then_some(f64::from(extra)),
                };
                *slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some(ScheduledLoopDecisionResult {
                        decision: if grant { "grant" } else { "stop" }.to_string(),
                        reason,
                    });
                apply_workflow_run_command(&current, &command).unwrap_or(current)
            })
            .await;
        if let Err(error) = result {
            return Some(Err(error));
        }
        workflow_engine::engine(&self.host).orchestrator().step(workflow_run_id).await;
        let decided = outcome.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        Some(Ok(decided.unwrap_or(ScheduledLoopDecisionResult {
            decision: "stop".into(),
            reason: "The repair loop could not be continued safely.".into(),
        })))
    }

    async fn approve_gate(&self, workflow_run_id: &str, node_id: &str) -> Option<Result<(), String>> {
        let policy = self
            .run(workflow_run_id)
            .and_then(|r| workflows::policy_for(&self.host, &r.project_id));
        let node_id = node_id.to_string();
        let result = self
            .update_run(workflow_run_id, move |current| {
                let target = (!node_id.is_empty()).then_some(node_id.as_str());
                let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                resolve_approval_target(&current, target)
                    .ok()
                    .and_then(|a| approve_stage(&current, &a.base.id, ACTOR, &at, policy.as_ref(), None).ok())
                    .filter(|r| r.ok)
                    .map_or(current, |r| r.run)
            })
            .await;
        if let Err(error) = result {
            return Some(Err(error));
        }
        workflow_engine::engine(&self.host).orchestrator().step(workflow_run_id).await;
        Some(Ok(()))
    }

    async fn retry_stage(&self, workflow_run_id: &str, node_id: &str) -> Option<Result<(), String>> {
        let node_id = node_id.to_string();
        let result = self
            .update_run(workflow_run_id, move |current| {
                let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                apply_workflow_run_command(&current, &WorkflowRunCommand::NodeRetry { node_id, at })
                    .unwrap_or(current)
            })
            .await;
        if let Err(error) = result {
            return Some(Err(error));
        }
        workflow_engine::engine(&self.host).orchestrator().step(workflow_run_id).await;
        Some(Ok(()))
    }

    async fn move_ticket(
        &self,
        request: &ScheduledMoveTicketRequest,
    ) -> Option<Result<Option<String>, String>> {
        let ScheduledMoveTicketRequest { run, entry, phase } = request;
        let ticket = &entry.ticket;
        let issue = match self
            .rpc("issue:get", vec![json!(ticket.issue_key), json!(ticket.connection_id)])
            .await
        {
            Ok(issue) => issue,
            Err(error) => return Some(Err(error)),
        };
        let transitions: Vec<WorkflowTransition> = issue["transitions"]
            .as_array()
            .map(|list| list.iter().filter_map(|t| serde_json::from_value(t.clone()).ok()).collect())
            .unwrap_or_default();
        let stages: Option<Vec<ProjectWorkflowStage>> = run
            .project_id
            .as_deref()
            .and_then(|id| workflows::project_workflow_stages(&self.host, id));
        let transition = scheduled_ticket_transition(
            issue["status"].as_str(),
            &transitions,
            *phase,
            stages.as_deref(),
        )?;
        let status = transition.to_status.clone().unwrap_or_else(|| transition.name.clone());
        // A folder-backed ticket is a file in the repository: written and committed in one turn on the
        // base checkout, or the checkout reads as dirty and the next ticket refuses to start.
        let folder = run.project_id.as_deref().and_then(|id| workflows::project_folder(&self.host, id));
        let _base = match &folder {
            Some(folder) => Some(workflow_engine::base_checkout_guard(folder).await),
            None => None,
        };
        let before = match &folder {
            Some(folder) => workflow_engine::changed_paths(folder).await.ok(),
            None => None,
        };
        let moved = self
            .rpc(
                "issue:transition",
                vec![json!(ticket.issue_key), json!(transition.id), json!(ticket.connection_id)],
            )
            .await;
        if let (Ok(_), Some(folder), Some(before)) = (&moved, &folder, &before) {
            let message = format!("Move {} to {status}", ticket.issue_key);
            if let Err(error) = workflow_engine::commit_praxis_write(folder, before, &message).await {
                eprintln!("Moved {} to {status} but could not commit it: {error}", ticket.issue_key);
            }
        }
        Some(moved.map(|_| Some(status)))
    }

    fn on_changed(&self, _run: &ScheduledRun) {
        self.host.events().emit("scheduledRuns:changed", None);
    }
}

/// The process-wide runner, created on first use.
pub fn runner(host: &HostContext) -> &'static Arc<ScheduledRunRunner> {
    static RUNNER: OnceLock<Arc<ScheduledRunRunner>> = OnceLock::new();
    RUNNER.get_or_init(|| Arc::new(ScheduledRunRunner::new(Arc::new(HostPorts { host: host.clone() }))))
}

/// Starts the tick timer once: recover what was in flight, then advance the schedules on an interval.
pub fn ensure_started(host: &HostContext) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    // The built-in skills (including the one that explains request files) are installed for every user.
    super::agent_runtime::refresh(host, &host.config().user_data_dir);
    let requests_host = host.clone();
    runtime::runtime().spawn(async move {
        loop {
            let host = requests_host.clone();
            let _ = tokio::task::spawn_blocking(move || super::scheduled_run_requests::check(&host)).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
    let active = Arc::clone(runner(host));
    let host = host.clone();
    // A run that was due while Praxis was closed shows as missed instead of starting.
    for run in super::scheduled_runs::list_runs(&host) {
        let before = run.status;
        let reconciled = praxis_workflows::scheduled_run::reconcile_scheduled_run_on_launch(run, &super::now());
        if reconciled.status != before {
            let _ = super::scheduled_runs::save_run(&host, reconciled);
        }
    }
    runtime::runtime().spawn(async move {
        active.recover().await;
        let mut ticker = tokio::time::interval(tick_interval());
        loop {
            ticker.tick().await;
            active.tick().await;
            let _ = &host;
        }
    });
}

/// A workflow run changed: let the schedule that launched it react.
pub fn workflow_changed(host: &HostContext, workflow_run_id: &str) {
    let active = Arc::clone(runner(host));
    let id = workflow_run_id.to_string();
    runtime::runtime().spawn(async move { active.handle_workflow_changed(&id).await });
}

/// Pause reasons the runner reports for a stage that stopped without a verdict.
#[allow(dead_code)]
fn pause_label(reason: WorkflowPauseReason) -> &'static str {
    match reason {
        WorkflowPauseReason::Environment => "environment",
        WorkflowPauseReason::ProviderLimit => "provider-limit",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_refused_for_trust_or_provider_pauses_for_that_reason() {
        assert_eq!(launch_reason("This project workflow needs local workspace trust. Review"), Some(ScheduledPauseReason::Trust));
        assert_eq!(launch_reason("This run needs Codex, which is not set up or turned off."), Some(ScheduledPauseReason::NoProvider));
        assert_eq!(launch_reason("1 uncommitted file in this project"), Some(ScheduledPauseReason::Policy));
    }
}
