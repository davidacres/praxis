//! Writes a settled, ticket-linked run's outcome back to its ticket as one comment
//! (`workflowOrchestratorInstance.ts` `writeBackToIssue` + `workflowIssueWriteBack.ts` port).
//!
//! Praxis has no target-status mapping for a tracker's own workflow, so this never transitions
//! the ticket: a comment is the one write-back every backend supports the same way. It is
//! best-effort: a failure is logged to the Output panel and never re-thrown, because the run has
//! already succeeded or failed on its own terms.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use praxis_host::HostContext;
use praxis_workflows::run::WorkflowRun;
use serde_json::{Value, json};

use super::workflow_summary::summarize_workflow_run;
use super::{log_bus, runtime, workflow_engine, workflows};

fn duration_text(started_at: &str, ended_at: &str) -> Option<String> {
    let start = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(ended_at).ok()?;
    let millis = (end - start).num_milliseconds();
    if millis < 0 {
        return None;
    }
    let seconds = (millis as f64 / 1000.0).round() as i64;
    if seconds < 60 {
        return Some(format!("{seconds}s"));
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return Some(format!("{minutes}m {}s", seconds % 60));
    }
    Some(format!("{}h {}m", minutes / 60, minutes % 60))
}

/// The comment body a settled run writes back; `with_duration` is off when comparing outcomes.
fn comment_body(run: &WorkflowRun, with_duration: bool) -> String {
    let summary = summarize_workflow_run(run, None);
    let status = summary["status"].as_str().unwrap_or("");
    let label = match status {
        "succeeded" => "Succeeded",
        "failed" => "Failed",
        "cancelled" => "Cancelled",
        other => other,
    };
    let duration = if with_duration {
        run.ended_at.as_deref().and_then(|end| duration_text(&run.started_at, end))
    } else {
        None
    };
    let stage_lines: Vec<String> = summary["stages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|stage| matches!(stage["type"].as_str(), Some("agent-task" | "check")))
        .map(|stage| {
            let outcome = stage["outcome"].as_str().unwrap_or("");
            let icon = match outcome {
                "succeeded" => "✅",
                "failed" => "❌",
                "skipped" | "cancelled" => "⏭️",
                _ => "⏳",
            };
            format!("- {icon} {}: {outcome}", stage["name"].as_str().unwrap_or(""))
        })
        .collect();
    let mut lines = vec![
        format!(
            "**Workflow run {}: {}**",
            label.to_lowercase(),
            summary["workflowName"].as_str().unwrap_or("")
        ),
        String::new(),
        format!(
            "Status: {label}{}",
            duration.map_or(String::new(), |d| format!(" · Duration: {d}"))
        ),
    ];
    if !stage_lines.is_empty() {
        lines.push(String::new());
        lines.extend(stage_lines);
    }
    if let Some(reason) = run.ended_reason.as_deref().filter(|r| !r.is_empty()) {
        lines.push(String::new());
        lines.push(reason.to_string());
    }
    lines.join("\n")
}

async fn rpc(host: &HostContext, channel: &'static str, args: Vec<Value>) -> Result<Value, String> {
    let h = host.clone();
    let response = tokio::task::spawn_blocking(move || {
        h.dispatch_rpc(praxis_contracts::RustRpcRequest { id: "run-write-back".into(), channel: channel.into(), args })
    })
    .await
    .map_err(|e| e.to_string())?;
    if response.ok {
        Ok(response.result.unwrap_or(Value::Null))
    } else {
        Err(response.error.map(|e| e.message).unwrap_or_else(|| "The board refused the request.".into()))
    }
}

async fn send(host: &HostContext, run: &WorkflowRun) -> Result<(), String> {
    let key = run.issue_key.clone().unwrap_or_default();
    let connection = run.issue_connection_id.clone().unwrap_or_default();
    // A folder-backed ticket is a file in the repository: commit what this comment changed, or the
    // checkout reads as dirty and the schedule's next ticket refuses to start.
    let folder = workflows::project_folder(host, &run.project_id);
    let root = match &folder {
        Some(folder) => praxis_core::git::run_work::repository_root(folder).await,
        None => None,
    };
    let _guard = match &folder {
        Some(folder) => Some(workflow_engine::base_checkout_guard(folder).await),
        None => None,
    };
    let before = match &root {
        Some(root) => workflow_engine::changed_paths(Path::new(root)).await.ok(),
        None => None,
    };
    let comment = comment_body(run, true);
    rpc(host, "issue:addComment", vec![json!(key), json!(comment), json!(connection)]).await?;
    if let (Some(root), Some(before)) = (root, before) {
        let marker = comment.lines().find(|l| !l.trim().is_empty()).unwrap_or(&comment).trim().to_string();
        let message = format!("{marker}\n\nRecord run outcome on {key}");
        if let Err(error) = workflow_engine::commit_praxis_write(Path::new(&root), &before, &message).await {
            log_bus::log(
                host,
                &format!("[workflow] Recorded the outcome on {key} but could not commit it: {error}"),
            );
        }
    }
    Ok(())
}

fn pending() -> &'static Mutex<HashSet<String>> {
    static PENDING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// Coalesces settle notifications: one write per run at a time, and an outcome identical to the
/// one already on the ticket is only marked, never sent twice.
pub fn write_back(host: &HostContext, run: &WorkflowRun) {
    if run.issue_key.as_deref().is_none_or(str::is_empty) || run.issue_write_back_at.is_some() {
        return;
    }
    {
        let mut busy = pending().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !busy.insert(run.run_id.clone()) {
            return;
        }
    }
    let (host, run_id) = (host.clone(), run.run_id.clone());
    runtime::runtime().spawn(async move {
        let result = async {
            let Some(run) = workflows::stored_run(&host, &run_id) else { return Ok(()) };
            if run.issue_key.as_deref().is_none_or(str::is_empty) || run.issue_write_back_at.is_some() {
                return Ok(());
            }
            let outcome = comment_body(&run, false);
            if run.issue_write_back_outcome.as_deref() != Some(outcome.as_str()) {
                send(&host, &run).await?;
            }
            let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            workflow_engine::engine(&host)
                .orchestrator()
                .update_run(&run_id, move |mut current| {
                    current.issue_write_back_at = Some(at);
                    current.issue_write_back_outcome = Some(outcome);
                    current
                })
                .await
        }
        .await;
        pending().lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&run_id);
        if let Err(error) = result {
            let key = workflows::stored_run(&host, &run_id)
                .and_then(|r| r.issue_key)
                .unwrap_or_default();
            log_bus::log(
                &host,
                &format!("[workflow] Could not write the outcome of run {run_id} back to {key}: {error}"),
            );
        }
    });
}
