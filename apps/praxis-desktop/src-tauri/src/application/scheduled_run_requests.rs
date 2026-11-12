//! Imports scheduled-run request files (`<workspace>/.praxis/scheduled-runs/*.json`) as unarmed
//! drafts (`scheduledRunRequests.ts`, `scheduledRunRequestWatcher.ts` port).
//!
//! This is how the built-in `praxis-scheduled-runs` skill lets an agent prepare a schedule without
//! driving the app: it writes a request, and Praxis answers with `<name>.status.json` beside it. A
//! request is read again only when its bytes change (the status file records the hash), so deleting
//! the draft in the app does not bring it back. A request never arms, starts or edits a schedule
//! that is no longer a draft.

use std::path::Path;
use std::sync::Mutex;

use praxis_contracts::{IssueSummary, RustRpcRequest};
use praxis_host::HostContext;
use praxis_workflows::scheduled_run::{
    ComposeScheduledRunInput, ScheduledRunStatus, compose_scheduled_run,
};
use praxis_workflows::scheduled_run_request::{
    SCHEDULED_RUN_REQUEST_FOLDER, ScheduledRunRequestError, ScheduledRunRequestState,
    ScheduledRunRequestStatus, is_scheduled_run_request_file, parse_scheduled_run_request,
    resolve_scheduled_run_request, scheduled_run_request_hash, scheduled_run_request_run_id,
    scheduled_run_request_status_file,
};
use serde_json::{Value, json};

use super::scheduled_runs;
use super::{storage, workflows};

const MAX_REQUEST_BYTES: u64 = 256 * 1024;

fn serial() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn project_issues(host: &HostContext, project_id: &str) -> Vec<IssueSummary> {
    let mut issues: Vec<IssueSummary> = Vec::new();
    let filter = json!({
        "projectKeys": [], "statuses": [], "issueTypes": [], "searchText": "",
        "assigneeMode": "all", "grouping": "none"
    });
    let mut offset = 0usize;
    loop {
        let response = host.dispatch_rpc(RustRpcRequest {
            id: "scheduled-request".into(),
            channel: "issue:list".into(),
            args: vec![
                filter.clone(),
                json!(offset),
                json!(200),
                json!(format!("project:{project_id}")),
            ],
        });
        let Some(page) = response.ok.then_some(response.result).flatten() else {
            break;
        };
        let batch: Vec<IssueSummary> = page["issues"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|i| serde_json::from_value(i.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        let count = batch.len();
        issues.extend(batch);
        if page["hasMore"] != json!(true) || count == 0 {
            break;
        }
        offset += count;
    }
    issues
}

fn import_one(
    host: &HostContext,
    folder_projects: &[String],
    file: &Path,
    text: &str,
    request_hash: &str,
) -> ScheduledRunRequestStatus {
    let checked_at = now();
    let base = |state: ScheduledRunRequestState, errors: Vec<String>| ScheduledRunRequestStatus {
        schema_version: 1,
        state,
        request_hash: request_hash.to_string(),
        checked_at: checked_at.clone(),
        run_id: None,
        run_status: None,
        project_id: None,
        workflow_id: None,
        scheduled_start_at: None,
        entries: None,
        errors,
        warnings: Vec::new(),
    };
    let rejected = |project_id: Option<String>, problems: Vec<String>| {
        let mut status = base(ScheduledRunRequestState::Rejected, problems);
        status.project_id = project_id;
        status
    };
    let request = match parse_scheduled_run_request(text) {
        Ok(request) => request,
        Err(error) => return rejected(None, error.problems),
    };
    let project_id = if let Some(wanted) = &request.project_id {
        if !folder_projects.contains(wanted) {
            return rejected(
                None,
                vec![format!(
                    "Project {wanted} does not use this folder. Projects here: {}.",
                    folder_projects.join(", ")
                )],
            );
        }
        wanted.clone()
    } else if folder_projects.len() == 1 {
        folder_projects[0].clone()
    } else {
        return rejected(
            None,
            vec![format!(
                "Several projects use this folder; set \"projectId\" to one of: {}.",
                folder_projects.join(", ")
            )],
        );
    };
    let fail = |problems: Vec<String>| rejected(Some(project_id.clone()), problems);

    let file_name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let run_id = scheduled_run_request_run_id(&project_id, &file_name);
    let existing = scheduled_runs::get_run(host, &run_id);
    if let Some(existing) = &existing
        && existing.status != ScheduledRunStatus::Draft
    {
        let status = serde_json::to_value(existing.status)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        return fail(vec![format!(
            "The schedule this file created is now {status}, so a request can no longer change it. Hold it in Praxis first, or write a request with a new file name."
        )]);
    }

    let issues = project_issues(host, &project_id);
    let resolved =
        match resolve_scheduled_run_request(&request, &issues, &format!("project:{project_id}")) {
            Ok(resolved) => resolved,
            Err(error) => return fail(error.problems),
        };
    let choices = workflows::workflow_choices_for(host, &project_id);
    let mut workflow_id = request.workflow_id.clone();
    if let Some(wanted) = &workflow_id
        && !choices.iter().any(|c| c["workflowId"] == json!(wanted))
    {
        let available: Vec<String> = choices
            .iter()
            .filter_map(|c| c["workflowId"].as_str().map(str::to_string))
            .collect();
        return fail(vec![format!(
            "Workflow \"{wanted}\" is not available in this project. Available: {}.",
            if available.is_empty() {
                "none".to_string()
            } else {
                available.join(", ")
            }
        )]);
    }
    if workflow_id.is_none() {
        workflow_id = choices
            .iter()
            .find(|c| c["trigger"] == "ticket")
            .or_else(|| {
                choices
                    .iter()
                    .find(|c| c["workflowId"] == "governed-delivery")
            })
            .and_then(|c| c["workflowId"].as_str().map(str::to_string));
    }
    let mut warnings = resolved.warnings.clone();
    if workflow_id.is_none() {
        warnings.push("No workflow was chosen and the project has no default; pick one in Praxis before arming.".to_string());
    }
    let composed = compose_scheduled_run(
        existing.clone(),
        ComposeScheduledRunInput {
            project_id: Some(project_id.clone()),
            name: request.name.clone(),
            date: request.date.clone(),
            time: request.time.clone(),
            timezone: request.timezone.clone(),
            tickets: resolved.tickets.clone(),
            with_previous: resolved.with_previous.clone(),
            workflow_id: workflow_id.clone(),
            max_concurrency: Some(resolved.max_concurrency),
            arm: false,
            at: checked_at.clone(),
        },
    );
    let mut run = match composed {
        Ok(run) => run,
        Err(error) => return fail(vec![error]),
    };
    if existing.is_none() {
        run.id = run_id;
    }
    let saved = match scheduled_runs::save_run(host, run) {
        Ok(saved) => saved,
        Err(error) => return fail(vec![error]),
    };
    host.events().emit("scheduledRuns:changed", None);
    let passed = chrono::DateTime::parse_from_rfc3339(&saved.scheduled_start_at)
        .ok()
        .zip(chrono::DateTime::parse_from_rfc3339(&checked_at).ok())
        .is_some_and(|(start, now)| start <= now);
    if passed {
        warnings.push(
            "The start time has already passed; choose a later time before arming.".to_string(),
        );
    }
    let mut status = base(ScheduledRunRequestState::Imported, Vec::new());
    status.run_id = Some(saved.id.clone());
    status.run_status = serde_json::to_value(saved.status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string));
    status.project_id = Some(project_id);
    status.workflow_id = workflow_id;
    status.scheduled_start_at = Some(saved.scheduled_start_at.clone());
    status.entries = Some(resolved.entries);
    status.warnings = warnings;
    status
}

fn read_status(file: &Path) -> Option<ScheduledRunRequestStatus> {
    serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()
}

fn write_status(file: &Path, status: &ScheduledRunRequestStatus) -> std::io::Result<()> {
    let temp = file.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(
        &temp,
        format!(
            "{}\n",
            serde_json::to_string_pretty(status).unwrap_or_default()
        ),
    )?;
    std::fs::rename(temp, file)
}

/// Reads every project's request folder once and imports new or changed requests.
pub fn check(host: &HostContext) {
    let _serial = serial()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Ok(catalog) =
        storage::Catalog::load_readonly(&host.config().user_data_dir, &host.config().settings_path)
    else {
        return;
    };
    let mut by_folder: Vec<(std::path::PathBuf, Vec<String>)> = Vec::new();
    for project in catalog.list(storage::PROJECTS) {
        let Some(folder) = project["workspaceFolder"]
            .as_str()
            .map(str::trim)
            .filter(|f| !f.is_empty())
        else {
            continue;
        };
        let key = std::path::absolute(folder).unwrap_or_else(|_| folder.into());
        let id = project["id"].as_str().unwrap_or_default().to_string();
        match by_folder.iter_mut().find(|(k, _)| *k == key) {
            Some((_, ids)) => ids.push(id),
            None => by_folder.push((key, vec![id])),
        }
    }
    for (folder, projects) in by_folder {
        let dir = folder.join(SCHEDULED_RUN_REQUEST_FOLDER);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .filter_map(std::result::Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| is_scheduled_run_request_file(n))
            .collect();
        names.sort();
        for name in names {
            let file = dir.join(&name);
            let status_file = dir.join(scheduled_run_request_status_file(&name));
            let Ok(meta) = std::fs::symlink_metadata(&file) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let oversize = meta.len() > MAX_REQUEST_BYTES;
            let (text, hash) = if oversize {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis());
                (String::new(), format!("oversize:{}:{mtime}", meta.len()))
            } else {
                let Ok(text) = std::fs::read_to_string(&file) else {
                    continue;
                };
                let hash = scheduled_run_request_hash(&text);
                (text, hash)
            };
            if read_status(&status_file).is_some_and(|s| s.request_hash == hash) {
                continue;
            }
            let status = if oversize {
                ScheduledRunRequestStatus {
                    schema_version: 1,
                    state: ScheduledRunRequestState::Rejected,
                    request_hash: hash,
                    checked_at: now(),
                    run_id: None,
                    run_status: None,
                    project_id: None,
                    workflow_id: None,
                    scheduled_start_at: None,
                    entries: None,
                    errors: vec![format!(
                        "The request is larger than {MAX_REQUEST_BYTES} bytes."
                    )],
                    warnings: Vec::new(),
                }
            } else {
                import_one(host, &projects, &file, &text, &hash)
            };
            let _ = write_status(&status_file, &status);
        }
    }
    let _: Option<ScheduledRunRequestError> = None;
    let _: Value = Value::Null;
}
