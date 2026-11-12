//! Task-completion notifications: when an AI session or workflow run finishes, fails or needs
//! the user, an OS notification is raised unless the person is already looking at it.
//!
//! The policy (what counts as a transition worth announcing) is pure and unit-tested. Delivery
//! goes through a [`NoticeShell`]: the desktop shell shows a native notification, the e2e server
//! records them so a spec can assert on what a user would have seen and drive a click.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use praxis_core::config::TaskNotificationSettings;
use praxis_host::HostContext;
use praxis_workflows::run::{WorkflowRun, WorkflowRunStatus, pause_reason_of};
use praxis_workflows::scheduler::schedule_workflow_run;
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Completed,
    Failed,
    NeedsAttention,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub category: Category,
    pub title: String,
    pub body: String,
    /// `{ sessionKey, projectId, conversation }` for a session, `{ runId, workflowId, projectId }` for a run.
    pub target: Value,
}

fn truncate(text: &str) -> String {
    text.chars().take(180).collect()
}

/// A non-empty string field (JS truthiness).
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn unsettled(state: &str) -> bool {
    matches!(state, "running" | "paused" | "unknown")
}

fn session_target(record: &Value, issue_key: &str) -> Value {
    let project = text(record, "projectId");
    let conversation = project.is_none() && text(record, "workflowRunId").is_none() && !issue_key.starts_with("review~");
    let mut target = json!({ "sessionKey": issue_key, "conversation": conversation });
    if let Some(project) = project {
        target["projectId"] = json!(project);
    }
    target
}

/// Small immutable signatures, never the records themselves.
#[derive(Default)]
pub struct Policy {
    sessions: HashMap<String, String>,
    background: HashMap<String, String>,
    runs: HashMap<String, String>,
}

impl Policy {
    pub fn session(&mut self, record: &Value, seed: bool) -> Option<Notice> {
        let issue_key = text(record, "issueKey")?;
        let state = text(record, "state").unwrap_or_default();
        let signature = format!(
            "{}:{state}:{}",
            text(record, "sessionId").unwrap_or_default(),
            record["conversation"]["state"].as_str().unwrap_or_default()
        );
        let previous = self.sessions.insert(issue_key.to_owned(), signature.clone());
        if seed || previous.as_deref() == Some(signature.as_str()) || record["interruptedByRestart"].as_bool() == Some(true) {
            return None;
        }
        let terminal = matches!(state, "completed" | "failed");
        // Stage completion belongs to the run. Permission/input requests still need an alert.
        if terminal
            && (previous.is_none()
                || text(record, "workflowNodeId").is_some()
                || text(record, "parentSessionKey").is_some()
                || record["conversation"]["state"] == "running")
        {
            return None;
        }
        let category = match state {
            "completed" => Category::Completed,
            "failed" => Category::Failed,
            "awaiting_approval" | "awaiting_input" | "paused" => Category::NeedsAttention,
            _ => return None,
        };
        if category == Category::Completed
            && record["backgroundTasks"]
                .as_array()
                .is_some_and(|tasks| tasks.iter().any(|t| unsettled(t["state"].as_str().unwrap_or_default())))
        {
            return None;
        }
        let title = match category {
            Category::Completed => "AI task completed",
            Category::Failed => "AI task failed",
            Category::NeedsAttention => "AI task needs your attention",
        };
        let body = text(record, "title").or_else(|| text(&record["taskDefinition"], "goal")).unwrap_or(issue_key);
        Some(Notice { category, title: title.into(), body: truncate(body), target: session_target(record, issue_key) })
    }

    pub fn background(&mut self, record: &Value, seed: bool) -> Vec<Notice> {
        let Some(issue_key) = text(record, "issueKey") else { return Vec::new() };
        let session_id = text(record, "sessionId").unwrap_or_default();
        let mut notices = Vec::new();
        for task in record["backgroundTasks"].as_array().map(Vec::as_slice).unwrap_or_default() {
            let state = task["state"].as_str().unwrap_or_default();
            let key = format!("{session_id}:{}", task["id"].as_str().unwrap_or_default());
            let previous = self.background.insert(key, state.to_owned());
            if seed || previous.as_deref() == Some(state) || state == "running" || state == "stopped" {
                continue;
            }
            let category = match state {
                "failed" => Category::Failed,
                "unknown" | "paused" => Category::NeedsAttention,
                _ => Category::Completed,
            };
            let title = match state {
                "exited" => "Background process exited",
                "unknown" => "Background task status unknown",
                "paused" => "Background task paused",
                "failed" => "Background task failed",
                _ => "Background task completed",
            };
            notices.push(Notice {
                category,
                title: title.into(),
                body: truncate(task["label"].as_str().unwrap_or_default()),
                target: session_target(record, issue_key),
            });
        }
        notices
    }

    pub fn run(&mut self, run: &WorkflowRun, seed: bool) -> Option<Notice> {
        let mut attention: Vec<String> = schedule_workflow_run(run).awaiting_approval;
        attention.extend(run.nodes.iter().filter(|(_, node)| pause_reason_of(node).is_some()).map(|(id, _)| id.clone()));
        attention.sort();
        let attention = attention.join(",");
        let phase = match run.status {
            WorkflowRunStatus::Succeeded => "succeeded".to_owned(),
            WorkflowRunStatus::Failed => "failed".to_owned(),
            WorkflowRunStatus::Cancelled => "cancelled".to_owned(),
            _ if !attention.is_empty() => format!("attention:{attention}"),
            WorkflowRunStatus::AwaitingApproval => "attention".to_owned(),
            WorkflowRunStatus::Running => "running".to_owned(),
        };
        let signature = format!("{}:{phase}", run.started_at);
        let previous = self.runs.insert(run.run_id.clone(), signature.clone());
        if seed || previous.as_deref() == Some(signature.as_str()) {
            return None;
        }
        let terminal = matches!(run.status, WorkflowRunStatus::Succeeded | WorkflowRunStatus::Failed);
        if terminal && previous.is_none() {
            return None;
        }
        let category = match run.status {
            WorkflowRunStatus::Succeeded => Category::Completed,
            WorkflowRunStatus::Failed => Category::Failed,
            WorkflowRunStatus::AwaitingApproval => Category::NeedsAttention,
            _ if !attention.is_empty() => Category::NeedsAttention,
            _ => return None,
        };
        let title = match category {
            Category::Completed => "Workflow completed",
            Category::Failed => "Workflow failed",
            Category::NeedsAttention => "Workflow needs your attention",
        };
        let name = run.display_name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&run.definition.name);
        Some(Notice {
            category,
            title: title.into(),
            body: truncate(name),
            target: json!({ "runId": run.run_id, "workflowId": run.workflow_id, "projectId": run.project_id }),
        })
    }
}

/// Whether a notice is wanted: its category is enabled and, if asked, nobody is already looking at it.
#[must_use]
pub fn should_notify(notice: &Notice, settings: &TaskNotificationSettings, views: &[Value]) -> bool {
    let enabled = match notice.category {
        Category::Completed => settings.completed,
        Category::Failed => settings.failed,
        Category::NeedsAttention => settings.needs_attention,
    };
    if !enabled {
        return false;
    }
    if !settings.suppress_when_viewing {
        return true;
    }
    !views.iter().any(|view| match notice.target["runId"].as_str() {
        Some(run_id) => view["runId"].as_str() == Some(run_id),
        None => view["sessionKey"].as_str() == notice.target["sessionKey"].as_str(),
    })
}

/// What the platform does with a notice. The desktop shell and the e2e server each supply one.
pub trait NoticeShell: Send + Sync {
    /// Labels of the windows that are focused, visible and not minimised.
    fn focused_windows(&self) -> Vec<String>;
    fn show(&self, notice: &Notice, silent: bool);
    /// A click on a notice: focus the chat's own window if it is popped out (`detached`), else
    /// bring the main window forward and tell it to open the target.
    fn open(&self, notice: &Notice, detached: Option<&str>);
}

pub struct Center {
    host: HostContext,
    policy: Mutex<Policy>,
    views: Mutex<BTreeMap<String, Value>>,
    shell: Arc<dyn NoticeShell>,
}

static CENTER: OnceLock<Arc<Center>> = OnceLock::new();

/// Starts announcing session transitions and (via [`run_changed`]) workflow run transitions.
pub fn install(host: &HostContext, shell: Arc<dyn NoticeShell>) -> Arc<Center> {
    let center = Arc::new(Center {
        host: host.clone(),
        policy: Mutex::new(Policy::default()),
        views: Mutex::new(BTreeMap::new()),
        shell,
    });
    // Whatever already exists is not news.
    if let Ok(mut policy) = center.policy.lock() {
        if let Ok(records) = super::session_store::store(&host.config().user_data_dir).all() {
            for record in records.values() {
                policy.session(record, true);
                policy.background(record, true);
            }
        }
        for run in super::workflows::all_runs(host) {
            policy.run(&run, true);
        }
    }
    let listener = Arc::clone(&center);
    host.events().on_event(move |envelope| {
        if envelope.channel == "ai:sessionChanged"
            && let Some(record) = &envelope.payload
        {
            listener.session_changed(record);
        }
    });
    let _ = CENTER.set(Arc::clone(&center));
    center
}

/// A workflow run was saved; announce it if it just crossed a line worth announcing.
pub fn run_changed(run: &WorkflowRun) {
    if let Some(center) = CENTER.get() {
        center.run_changed(run);
    }
}

/// The window `label` is now showing `target` (a session or a run), or nothing (`{}`).
pub fn set_view(label: &str, target: &Value) {
    if let Some(center) = CENTER.get() {
        center.set_view(label, target);
    }
}

impl Center {
    pub fn set_view(&self, label: &str, target: &Value) {
        let mut view = serde_json::Map::new();
        for key in ["sessionKey", "runId"] {
            if let Some(value) = target.get(key).and_then(Value::as_str).filter(|v| v.len() < 512) {
                view.insert(key.into(), json!(value));
            }
        }
        if let Ok(mut views) = self.views.lock() {
            views.insert(label.to_owned(), Value::Object(view));
        }
    }

    fn session_changed(&self, record: &Value) {
        let (session, background) = match self.policy.lock() {
            Ok(mut policy) => (policy.session(record, false), policy.background(record, false)),
            Err(_) => return,
        };
        for notice in session.into_iter().chain(background) {
            self.deliver(&notice);
        }
    }

    fn run_changed(&self, run: &WorkflowRun) {
        let notice = self.policy.lock().ok().and_then(|mut policy| policy.run(run, false));
        if let Some(notice) = notice {
            self.deliver(&notice);
        }
    }

    /// Best effort: a notification failure must never interrupt a provider or workflow.
    fn deliver(&self, notice: &Notice) {
        let settings = self.host.settings().read().notifications;
        let focused = self.shell.focused_windows();
        let views: Vec<Value> = match self.views.lock() {
            Ok(views) => focused.iter().map(|label| views.get(label).cloned().unwrap_or_else(|| json!({}))).collect(),
            Err(_) => return,
        };
        if should_notify(notice, &settings, &views) {
            self.shell.show(notice, !settings.sound);
        }
    }

    /// The user clicked a notice.
    pub fn click(&self, notice: &Notice) {
        let popped_out = notice.target["sessionKey"].as_str().filter(|key| {
            self.host
                .dispatch_rpc(praxis_contracts::RustRpcRequest { id: "notice-click".into(), channel: "detachedChat:list".into(), args: vec![] })
                .result
                .and_then(|keys| keys.as_array().cloned())
                .is_some_and(|keys| keys.iter().any(|k| k.as_str() == Some(key)))
        });
        self.shell.open(notice, popped_out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(state: &str) -> Value {
        json!({ "issueKey": "S-1", "sessionId": "abc", "state": state, "taskDefinition": { "goal": "Do it" } })
    }

    #[test]
    fn completion_after_work_notifies_once() {
        let mut policy = Policy::default();
        assert!(policy.session(&session("not_started"), false).is_none());
        assert!(policy.session(&session("executing"), false).is_none());
        let notice = policy.session(&session("completed"), false).expect("notice");
        assert_eq!(notice.title, "AI task completed");
        assert_eq!(notice.body, "Do it");
        assert_eq!(notice.target, json!({ "sessionKey": "S-1", "conversation": true }));
        assert!(policy.session(&session("completed"), false).is_none(), "an unchanged signature is not news");
    }

    #[test]
    fn first_sight_of_a_terminal_session_and_seeding_are_silent() {
        let mut policy = Policy::default();
        assert!(policy.session(&session("completed"), false).is_none());
        let mut seeded = Policy::default();
        seeded.session(&session("executing"), true);
        assert!(seeded.session(&session("executing"), false).is_none());
        assert!(seeded.session(&session("completed"), false).is_some());
    }

    #[test]
    fn stage_sessions_and_unsettled_background_work_do_not_announce_completion() {
        let mut policy = Policy::default();
        policy.session(&session("executing"), false);
        let mut stage = session("completed");
        stage["workflowNodeId"] = json!("review");
        assert!(policy.session(&stage, false).is_none());
        let mut waiting = session("executing");
        waiting["issueKey"] = json!("S-2");
        policy.session(&waiting, false);
        waiting["state"] = json!("completed");
        waiting["backgroundTasks"] = json!([{ "id": "t", "state": "running", "label": "tests" }]);
        assert!(policy.session(&waiting, false).is_none());
    }

    #[test]
    fn attention_and_failure_categories() {
        let mut policy = Policy::default();
        policy.session(&session("executing"), false);
        assert_eq!(policy.session(&session("awaiting_approval"), false).expect("n").category, Category::NeedsAttention);
        policy.session(&session("executing"), false);
        assert_eq!(policy.session(&session("failed"), false).expect("n").title, "AI task failed");
    }

    #[test]
    fn background_task_transitions_announce_once_each() {
        let mut policy = Policy::default();
        let mut record = session("completed");
        record["backgroundTasks"] = json!([{ "id": "t", "state": "running", "label": "build" }]);
        assert!(policy.background(&record, false).is_empty());
        record["backgroundTasks"][0]["state"] = json!("exited");
        let notices = policy.background(&record, false);
        assert_eq!(notices.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), ["Background process exited"]);
        assert!(policy.background(&record, false).is_empty());
        record["backgroundTasks"][0]["state"] = json!("unknown");
        assert_eq!(policy.background(&record, false)[0].category, Category::NeedsAttention);
    }

    #[test]
    fn viewing_the_target_suppresses_only_when_asked() {
        let notice = Notice { category: Category::Completed, title: String::new(), body: String::new(), target: json!({ "sessionKey": "S-1" }) };
        let mut settings = praxis_core::config::default_app_settings().notifications;
        settings.completed = true;
        settings.suppress_when_viewing = true;
        assert!(should_notify(&notice, &settings, &[json!({})]));
        assert!(!should_notify(&notice, &settings, &[json!({ "sessionKey": "S-1" })]));
        settings.suppress_when_viewing = false;
        assert!(should_notify(&notice, &settings, &[json!({ "sessionKey": "S-1" })]));
        settings.completed = false;
        assert!(!should_notify(&notice, &settings, &[]));
    }
}
