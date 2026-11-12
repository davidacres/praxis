//! A workflow run as the phone shows it (`apps/praxis-desktop/main/src/main/mobileRunProjection.ts`
//! port).
//!
//! The workflow-run monitor is not in Rust yet, so [`MobileRunSummaryInput`] is the read-only
//! slice of its `WorkflowRunSummary` the projection needs, deserialised from the TS JSON.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::ledger::MobileCommandLedger;
use super::protocol::{MOBILE_PROTOCOL_VERSION, MobileEventEnvelope, MobileTarget, now_iso};
use super::session_record::truthy;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileRunFindings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub findings: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileRunStageInput {
    pub node_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub lane: String,
    #[serde(default)]
    pub attempts: u64,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_key: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub chosen_provider: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub pause: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub exit_code: Option<Value>,
    #[serde(default)]
    pub gate: Option<String>,
    #[serde(default)]
    pub findings: Option<MobileRunFindings>,
    #[serde(default)]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileRunSummaryInput {
    pub run_id: String,
    pub project_id: String,
    #[serde(default)]
    pub workflow_name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub paused: Option<bool>,
    #[serde(default)]
    pub explanation: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub ai_provider: Option<String>,
    #[serde(default)]
    pub ai_model: Option<String>,
    #[serde(default)]
    pub stages: Vec<MobileRunStageInput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileRunStage {
    pub node_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub lane: String,
    pub attempts: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
    /// The AI that ran the latest attempt, else the one it is set to use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub findings_summary: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileRunSnapshot {
    pub run_id: String,
    pub project_id: String,
    pub workflow_name: String,
    pub status: String,
    pub paused: bool,
    pub explanation: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_node_id: Option<String>,
    pub stages: Vec<MobileRunStage>,
    pub can_approve: bool,
    pub sequence: u64,
}

/// The stage the phone puts in place of its composer: running work first (an agent stage over a
/// check beside it), then a stage waiting on a person, then one paused, then a failure; else the
/// last stage that did anything, else the first.
pub fn current_run_stage(stages: &[MobileRunStage]) -> Option<String> {
    let in_lane = |lane: &'static str| stages.iter().filter(move |s| s.lane == lane);
    in_lane("running")
        .find(|s| s.kind == "agent-task")
        .or_else(|| in_lane("running").next())
        .or_else(|| in_lane("awaiting").next())
        .or_else(|| in_lane("paused").next())
        .or_else(|| in_lane("failed").next())
        .or_else(|| {
            stages
                .iter()
                .rev()
                .find(|s| s.lane == "done" && s.attempts > 0)
        })
        .or_else(|| stages.iter().rev().find(|s| s.lane == "done"))
        .or_else(|| stages.first())
        .map(|s| s.node_id.clone())
}

fn stage(input: &MobileRunStageInput) -> MobileRunStage {
    let findings = input.findings.as_ref();
    let findings_summary = findings
        .and_then(|f| f.findings.as_ref())
        .filter(|list| !list.is_empty())
        .map(|list| {
            let mut summary = Map::new();
            for finding in list {
                let severity = match finding.get("severity") {
                    Some(Value::String(text)) => text.clone(),
                    Some(other) => other.to_string(),
                    None => "undefined".to_owned(),
                };
                let count = summary.get(&severity).and_then(Value::as_u64).unwrap_or(0);
                summary.insert(severity, json!(count + 1));
            }
            summary
        });
    MobileRunStage {
        node_id: input.node_id.clone(),
        name: input.name.clone(),
        kind: input.kind.clone(),
        lane: input.lane.clone(),
        attempts: input.attempts,
        session_id: truthy(&input.session_id).cloned(),
        session_key: truthy(&input.session_key).cloned(),
        provider: truthy(&input.provider)
            .or_else(|| truthy(&input.chosen_provider))
            .cloned(),
        last_error: truthy(&input.last_error).cloned(),
        pause: truthy(&input.pause).cloned(),
        command: truthy(&input.command).cloned(),
        exit_code: input.exit_code.clone(),
        gate: truthy(&input.gate).cloned(),
        metrics: findings
            .and_then(|f| f.metrics.clone())
            .filter(|metrics| !metrics.is_empty()),
        findings_summary,
        prompt: truthy(&input.prompt).cloned(),
    }
}

pub fn mobile_run_snapshot(summary: &MobileRunSummaryInput, sequence: u64) -> MobileRunSnapshot {
    let stages: Vec<MobileRunStage> = summary.stages.iter().map(stage).collect();
    MobileRunSnapshot {
        run_id: summary.run_id.clone(),
        project_id: summary.project_id.clone(),
        workflow_name: summary.workflow_name.clone(),
        status: summary.status.clone(),
        paused: summary.paused == Some(true),
        explanation: summary.explanation.clone(),
        started_at: summary.started_at.clone(),
        ended_at: truthy(&summary.ended_at).cloned(),
        issue_key: truthy(&summary.issue_key).cloned(),
        ai_provider: truthy(&summary.ai_provider).cloned(),
        ai_model: truthy(&summary.ai_model).cloned(),
        current_node_id: current_run_stage(&stages),
        can_approve: summary.status == "awaiting-approval",
        stages,
        sequence,
    }
}

/// A run change for the event log.
pub enum MobileRunChange<'a> {
    Summary(&'a MobileRunSummaryInput),
    Removed {
        run_id: &'a str,
        project_id: &'a str,
    },
}

/// Appends a run change to the mobile event log, scoped to the run's project like a session's.
pub fn append_mobile_run_event(
    ledger: &dyn MobileCommandLedger,
    host_id: &str,
    change: MobileRunChange<'_>,
) -> u64 {
    let sequence = ledger.latest_sequence() + 1;
    let (run_id, project_id) = match &change {
        MobileRunChange::Summary(summary) => (summary.run_id.as_str(), summary.project_id.as_str()),
        MobileRunChange::Removed { run_id, project_id } => (*run_id, *project_id),
    };
    let event = match &change {
        MobileRunChange::Summary(summary) => {
            json!({ "type": "run.snapshot", "run": mobile_run_snapshot(summary, sequence) })
        }
        MobileRunChange::Removed { run_id, .. } => {
            json!({ "type": "run.removed", "runId": run_id })
        }
    };
    ledger.append_event(MobileEventEnvelope {
        protocol_version: MOBILE_PROTOCOL_VERSION,
        event_id: format!("run:{run_id}:{sequence}"),
        sequence,
        emitted_at: now_iso(),
        target: MobileTarget {
            host_id: host_id.to_owned(),
            project_id: Some(project_id.to_owned()),
            run_id: Some(run_id.to_owned()),
            ..MobileTarget::default()
        },
        event,
    });
    sequence
}

/// Announces that a project's schedules changed; the phone refetches `schedules.list`.
pub fn append_mobile_schedules_event(
    ledger: &dyn MobileCommandLedger,
    host_id: &str,
    project_id: &str,
) -> u64 {
    let sequence = ledger.latest_sequence() + 1;
    ledger.append_event(MobileEventEnvelope {
        protocol_version: MOBILE_PROTOCOL_VERSION,
        event_id: format!("schedules:{sequence}"),
        sequence,
        emitted_at: now_iso(),
        target: MobileTarget {
            host_id: host_id.to_owned(),
            project_id: Some(project_id.to_owned()),
            ..MobileTarget::default()
        },
        event: json!({ "type": "scheduledRuns.changed" }),
    });
    sequence
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::ledger::{InMemoryMobileCommandLedger, MOBILE_REPLAY_LIMIT};

    #[test]
    fn a_schedules_change_is_a_project_scoped_event_with_the_next_sequence() {
        let ledger = InMemoryMobileCommandLedger::default();
        assert_eq!(append_mobile_schedules_event(&ledger, "host", "p1"), 1);
        assert_eq!(append_mobile_schedules_event(&ledger, "host", "p2"), 2);
        let events = ledger.replay(0, MOBILE_REPLAY_LIMIT);
        assert_eq!(events[1].event_id, "schedules:2");
        assert_eq!(events[1].target.project_id.as_deref(), Some("p2"));
        assert_eq!(events[1].event, json!({ "type": "scheduledRuns.changed" }));
    }

    fn input(node_id: &str, patch: Value) -> MobileRunStageInput {
        let mut name = node_id.to_owned();
        name[..1].make_ascii_uppercase();
        let mut base = json!({ "nodeId": node_id, "name": name, "type": "agent-task", "outcome": "pending", "lane": "idle", "attempts": 0, "artifacts": [] });
        if let (Some(base), Some(patch)) = (base.as_object_mut(), patch.as_object()) {
            for (key, value) in patch {
                base.insert(key.clone(), value.clone());
            }
        }
        serde_json::from_value(base).expect("stage")
    }

    fn stages(inputs: &[MobileRunStageInput]) -> Vec<MobileRunStage> {
        inputs.iter().map(stage).collect()
    }

    fn summary(inputs: Vec<MobileRunStageInput>, patch: Value) -> MobileRunSummaryInput {
        let mut base = json!({
            "runId": "run-1", "projectId": "p1", "workflowName": "Governed delivery — FX-1",
            "status": "running", "explanation": "Implement is running.", "startedAt": "2026-09-23T22:55:59.686Z",
            "graph": {}, "gates": [], "events": []
        });
        if let (Some(base), Some(patch)) = (base.as_object_mut(), patch.as_object()) {
            for (key, value) in patch {
                base.insert(key.clone(), value.clone());
            }
        }
        let mut summary: MobileRunSummaryInput = serde_json::from_value(base).expect("summary");
        summary.stages = inputs;
        summary
    }

    #[test]
    fn the_current_stage_is_the_running_agent_stage_even_beside_a_running_check() {
        assert_eq!(
            current_run_stage(&stages(&[
                input("plan", json!({ "lane": "done", "attempts": 1 })),
                input(
                    "lint",
                    json!({ "type": "check", "lane": "running", "attempts": 1 })
                ),
                input("implement", json!({ "lane": "running", "attempts": 2 })),
            ])),
            Some("implement".into())
        );
        assert_eq!(
            current_run_stage(&stages(&[
                input("plan", json!({ "lane": "done", "attempts": 1 })),
                input(
                    "qa",
                    json!({ "type": "check", "lane": "running", "attempts": 1 })
                ),
            ])),
            Some("qa".into())
        );
    }

    #[test]
    fn with_nothing_running_it_is_waiting_then_paused_then_failed() {
        let done = input("implement", json!({ "lane": "done", "attempts": 1 }));
        assert_eq!(
            current_run_stage(&stages(&[
                done.clone(),
                input("approve", json!({ "type": "approval", "lane": "awaiting" })),
                input("review", json!({ "lane": "paused", "attempts": 1 })),
            ])),
            Some("approve".into())
        );
        assert_eq!(
            current_run_stage(&stages(&[
                done.clone(),
                input("review", json!({ "lane": "paused", "attempts": 1 })),
                input("qa", json!({ "lane": "failed", "attempts": 1 })),
            ])),
            Some("review".into())
        );
        assert_eq!(
            current_run_stage(&stages(&[
                done,
                input("qa", json!({ "lane": "failed", "attempts": 1 }))
            ])),
            Some("qa".into())
        );
    }

    #[test]
    fn a_run_between_stages_or_finished_shows_the_last_stage_that_did_something() {
        assert_eq!(
            current_run_stage(&stages(&[
                input("plan", json!({ "lane": "done", "attempts": 1 })),
                input("implement", json!({ "lane": "done", "attempts": 1 })),
                input("gates", json!({ "type": "join", "lane": "done" })),
                input("approve", json!({ "type": "approval", "lane": "idle" })),
            ])),
            Some("implement".into())
        );
        assert_eq!(
            current_run_stage(&stages(&[
                input("plan", json!({})),
                input("implement", json!({}))
            ])),
            Some("plan".into())
        );
        assert_eq!(current_run_stage(&[]), None);
    }

    #[test]
    fn the_snapshot_carries_each_stages_session_and_ai_and_whether_a_person_can_approve() {
        let snapshot = mobile_run_snapshot(
            &summary(
                vec![
                    input(
                        "plan",
                        json!({ "lane": "done", "attempts": 3, "sessionId": "s-plan", "sessionKey": "WF-RUN1-plan", "provider": "claude-code-cli" }),
                    ),
                    input(
                        "implement",
                        json!({ "lane": "running", "attempts": 2, "sessionId": "s-impl", "sessionKey": "WF-RUN1-implement", "chosenProvider": "claude-code-cli" }),
                    ),
                    input(
                        "review",
                        json!({ "lane": "paused", "attempts": 1, "pause": "provider-limit", "lastError": "Provider limit reached: …" }),
                    ),
                ],
                json!({ "aiProvider": "codex-cli", "aiModel": "gpt-5.6-terra", "issueKey": "FX-1" }),
            ),
            42,
        );
        assert_eq!(snapshot.current_node_id.as_deref(), Some("implement"));
        assert_eq!(snapshot.sequence, 42);
        assert!(!snapshot.can_approve);
        assert!(!snapshot.paused);
        assert_eq!(
            serde_json::to_value(&snapshot.stages[0]).expect("json"),
            json!({ "nodeId": "plan", "name": "Plan", "type": "agent-task", "lane": "done", "attempts": 3, "sessionId": "s-plan", "sessionKey": "WF-RUN1-plan", "provider": "claude-code-cli" })
        );
        assert_eq!(
            snapshot.stages[1].provider.as_deref(),
            Some("claude-code-cli")
        );
        assert_eq!(snapshot.stages[2].pause.as_deref(), Some("provider-limit"));
        assert_eq!(
            snapshot.stages[2].last_error.as_deref(),
            Some("Provider limit reached: …")
        );
        let awaiting = mobile_run_snapshot(
            &summary(
                vec![input("approve", json!({ "lane": "awaiting" }))],
                json!({ "status": "awaiting-approval" }),
            ),
            1,
        );
        assert!(awaiting.can_approve);

        let check = mobile_run_snapshot(
            &summary(
                vec![input(
                    "qa",
                    json!({
                        "type": "check", "lane": "done", "attempts": 1, "command": "npm test", "exitCode": 0, "gate": "qa",
                        "findings": {
                            "metrics": { "passed": 51, "failed": 0 },
                            "findings": [{ "ruleId": "r1", "file": "f.ts", "line": 1, "message": "m", "severity": "low", "fingerprint": "fp1", "category": "quality" }]
                        }
                    }),
                )],
                json!({}),
            ),
            2,
        );
        let qa = &check.stages[0];
        assert_eq!(qa.command.as_deref(), Some("npm test"));
        assert_eq!(qa.exit_code, Some(json!(0)));
        assert_eq!(qa.gate.as_deref(), Some("qa"));
        assert_eq!(
            qa.metrics.clone().map(Value::Object),
            Some(json!({ "passed": 51, "failed": 0 }))
        );
        assert_eq!(
            qa.findings_summary.clone().map(Value::Object),
            Some(json!({ "low": 1 }))
        );
    }

    #[test]
    fn run_events_are_scoped_to_the_runs_project_and_a_removal_says_which_run_went() {
        let ledger = InMemoryMobileCommandLedger::default();
        let run = summary(
            vec![input("plan", json!({ "lane": "running", "attempts": 1 }))],
            json!({}),
        );
        let first = append_mobile_run_event(&ledger, "host-mac", MobileRunChange::Summary(&run));
        let second = append_mobile_run_event(
            &ledger,
            "host-mac",
            MobileRunChange::Removed {
                run_id: "run-1",
                project_id: "p1",
            },
        );
        assert_eq!(second, first + 1);
        let events = ledger.replay(0, MOBILE_REPLAY_LIMIT);
        let expected = MobileTarget {
            host_id: "host-mac".into(),
            project_id: Some("p1".into()),
            run_id: Some("run-1".into()),
            ..MobileTarget::default()
        };
        assert!(events.iter().all(|e| e.target == expected));
        assert_eq!(events[0].event["type"], json!("run.snapshot"));
        assert_eq!(events[0].event["run"]["sequence"], json!(first));
        assert_eq!(
            events[1].event,
            json!({ "type": "run.removed", "runId": "run-1" })
        );
    }
}
