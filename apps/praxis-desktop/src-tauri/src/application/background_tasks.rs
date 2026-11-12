//! Provider background-task protocol: the AIR `asyncTasks` / `nativeSubagentSessions` ACP extension.
//! Ports `packages/core/src/ai/backgroundTasks.ts`. Status is only ever what the provider explicitly
//! reports; nothing is inferred from prose.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

/// The `_meta` block a client sends in `initialize` to negotiate the extension.
pub fn client_meta() -> Value {
    serde_json::json!({ "jetbrains": { "air": { "version": 1, "capabilities": ["asyncTasks", "nativeSubagentSessions"] } } })
}

pub fn is_live(state: &Value) -> bool {
    matches!(state.as_str(), Some("running" | "paused"))
}

/// One lifecycle beat read from a provider notification.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProviderBackgroundUpdate {
    pub id: String,
    pub state: Option<String>,
    pub label: Option<String>,
    pub detail: Option<String>,
    pub call_id: Option<String>,
}

fn string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(2000).collect())
}

fn native_subagent(value: &Value) -> Option<(String, String)> {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(Start|Complete|Interrupt) subagent (.+)$").expect("static pattern")
    });
    [&value["title"], &value["name"]]
        .into_iter()
        .find_map(|field| {
            let text = string(field)?;
            let found = PATTERN.captures(&text)?;
            Some((found[1].to_lowercase(), found[2].to_owned()))
        })
}

pub fn read_provider_background_update(update: &Value) -> Option<ProviderBackgroundUpdate> {
    let kind = update["sessionUpdate"].as_str().unwrap_or_default();
    match kind {
        "subagent_spawned" | "subagent_state_update" => {
            let id = string(&update["subagentSessionId"]).filter(|id| id.chars().count() <= 256)?;
            let state = if kind == "subagent_spawned" {
                "running"
            } else {
                match update["state"].as_str()? {
                    "cancelled" => "stopped",
                    "disconnected" => "unknown",
                    "completed" => "completed",
                    "failed" => "failed",
                    _ => return None,
                }
            };
            let detail = if kind == "subagent_spawned" {
                string(&update["task"])
            } else if state == "unknown" {
                Some(
                    "The provider disconnected from this subagent before confirming its result."
                        .to_owned(),
                )
            } else {
                None
            };
            Some(ProviderBackgroundUpdate {
                id: format!("child:{id}"),
                state: Some(state.into()),
                label: string(&update["name"]),
                detail,
                call_id: None,
            })
        }
        "tool_call" | "tool_call_update" => {
            let (action, name) = native_subagent(update)?;
            let status = update["status"].as_str().unwrap_or_default();
            let terminal = status == "completed" || status == "failed";
            if action != "start" && !terminal {
                return None;
            }
            let state = if status == "failed" {
                "failed"
            } else {
                match action.as_str() {
                    "start" => "running",
                    "interrupt" => "stopped",
                    _ => "completed",
                }
            };
            let name = name.trim().to_owned();
            Some(ProviderBackgroundUpdate {
                id: format!("subagent:{name}"),
                state: Some(state.into()),
                label: Some(name),
                detail: None,
                call_id: string(&update["toolCallId"]),
            })
        }
        "async_task_spawned" | "async_task_progress" | "async_task_state_update" => {
            let id = string(&update["asyncTaskId"]).filter(|id| id.chars().count() <= 256)?;
            let state = match kind {
                "async_task_spawned" => Some("running".to_owned()),
                "async_task_state_update" => {
                    let state = update["state"].as_str().filter(|s| {
                        matches!(
                            *s,
                            "running" | "paused" | "completed" | "failed" | "stopped"
                        )
                    })?;
                    Some(state.to_owned())
                }
                _ => None,
            };
            Some(ProviderBackgroundUpdate {
                id,
                state,
                label: string(&update["description"]).or_else(|| string(&update["name"])),
                detail: string(&update["summary"]),
                call_id: string(&update["toolCallId"]),
            })
        }
        _ => None,
    }
}

/// An older adapter's structured launch result: launching is not finishing.
pub fn read_unobserved_background_launch(update: &Value) -> Option<ProviderBackgroundUpdate> {
    if !matches!(
        update["sessionUpdate"].as_str(),
        Some("tool_call" | "tool_call_update")
    ) || update["status"] != "completed"
    {
        return None;
    }
    let id =
        string(&update["rawOutput"]["backgroundTaskId"]).filter(|id| id.chars().count() <= 256)?;
    Some(ProviderBackgroundUpdate {
        id,
        state: Some("unknown".into()),
        label: Some(string(&update["title"]).unwrap_or_else(|| "Provider background task".into())),
        detail: Some("The provider launched this task but has not reported its live status. Completion is not confirmed.".into()),
        call_id: string(&update["toolCallId"]),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn async_task_beats_map_to_states() {
        let spawned = read_provider_background_update(&json!({ "sessionUpdate": "async_task_spawned", "asyncTaskId": "a", "description": "Run checks", "toolCallId": "t" })).unwrap();
        assert_eq!(
            (
                spawned.id.as_str(),
                spawned.state.as_deref(),
                spawned.label.as_deref(),
                spawned.call_id.as_deref()
            ),
            ("a", Some("running"), Some("Run checks"), Some("t"))
        );
        let progress = read_provider_background_update(&json!({ "sessionUpdate": "async_task_progress", "asyncTaskId": "a", "summary": "half" })).unwrap();
        assert_eq!(
            (progress.state, progress.detail.as_deref()),
            (None, Some("half"))
        );
        assert!(read_provider_background_update(&json!({ "sessionUpdate": "async_task_state_update", "asyncTaskId": "a", "state": "weird" })).is_none());
        assert!(
            read_provider_background_update(
                &json!({ "sessionUpdate": "async_task_state_update", "state": "completed" })
            )
            .is_none()
        );
    }

    #[test]
    fn subagent_sessions_and_native_tool_calls() {
        let gone = read_provider_background_update(&json!({ "sessionUpdate": "subagent_state_update", "subagentSessionId": "c", "state": "disconnected" })).unwrap();
        assert_eq!(
            (gone.id.as_str(), gone.state.as_deref()),
            ("child:c", Some("unknown"))
        );
        let cancelled = read_provider_background_update(&json!({ "sessionUpdate": "subagent_state_update", "subagentSessionId": "c", "state": "cancelled" })).unwrap();
        assert_eq!(cancelled.state.as_deref(), Some("stopped"));
        let start = read_provider_background_update(&json!({ "sessionUpdate": "tool_call", "title": "Start subagent rev", "status": "in_progress", "toolCallId": "s" })).unwrap();
        assert_eq!(
            (start.id.as_str(), start.state.as_deref()),
            ("subagent:rev", Some("running"))
        );
        assert!(read_provider_background_update(&json!({ "sessionUpdate": "tool_call_update", "title": "Complete subagent rev", "status": "in_progress" })).is_none());
        let failed = read_provider_background_update(&json!({ "sessionUpdate": "tool_call_update", "title": "Complete subagent rev", "status": "failed" })).unwrap();
        assert_eq!(failed.state.as_deref(), Some("failed"));
    }

    #[test]
    fn launch_results_are_unknown_not_complete() {
        let launch = read_unobserved_background_launch(&json!({ "sessionUpdate": "tool_call_update", "status": "completed", "rawOutput": { "backgroundTaskId": "b" } })).unwrap();
        assert_eq!(
            (launch.id.as_str(), launch.state.as_deref()),
            ("b", Some("unknown"))
        );
        assert!(read_unobserved_background_launch(&json!({ "sessionUpdate": "tool_call_update", "status": "in_progress", "rawOutput": { "backgroundTaskId": "b" } })).is_none());
    }
}
