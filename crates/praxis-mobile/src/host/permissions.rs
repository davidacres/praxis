//! Pending tool-permission requests a phone can answer
//! (`apps/praxis-desktop/main/src/main/mobilePermissions.ts` port).
//!
//! A request id is `<sessionId>:permission:<eventIndex>`. A session's requests are answered
//! oldest first by the AI hosts, whatever id is named, so answering a later one while an earlier
//! one waits is refused — it would really decide the earlier one.

use serde::{Deserialize, Serialize};

use super::session_record::{MobileSessionRecord, truthy};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePermissionRequest {
    pub request_id: String,
    pub session_id: String,
    pub session_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub created_at: String,
}

/// What the phone answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MobilePermissionAnswer {
    Allow,
    AllowAlways,
    Deny,
}

impl MobilePermissionAnswer {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "allow_always" => Some(Self::AllowAlways),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }
}

/// What the desktop's AI host is told (`PermissionDecision`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    AllowAlways,
    Deny,
}

impl From<MobilePermissionAnswer> for PermissionDecision {
    fn from(answer: MobilePermissionAnswer) -> Self {
        match answer {
            MobilePermissionAnswer::Allow => Self::AllowOnce,
            MobilePermissionAnswer::AllowAlways => Self::AllowAlways,
            MobilePermissionAnswer::Deny => Self::Deny,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePermissionResponse {
    pub request_id: String,
    pub decision: MobilePermissionAnswer,
    pub session_id: String,
}

/// Every unresolved request of every session still awaiting approval.
pub fn pending_mobile_permissions<'a>(
    records: impl IntoIterator<Item = &'a MobileSessionRecord>,
) -> Vec<MobilePermissionRequest> {
    let mut pending = Vec::new();
    for record in records {
        if record.state != "awaiting_approval" {
            continue;
        }
        let mut session_pending: Vec<MobilePermissionRequest> = Vec::new();
        for (index, event) in record.events.iter().enumerate() {
            match event.kind.as_str() {
                "permission_requested" => session_pending.push(MobilePermissionRequest {
                    request_id: format!("{}:permission:{index}", record.session_id),
                    session_id: record.session_id.clone(),
                    session_key: record.issue_key.clone(),
                    project_id: truthy(&record.project_id).cloned(),
                    summary: event.summary.clone(),
                    detail: event.detail().map(str::to_owned),
                    created_at: event.timestamp.clone(),
                }),
                "permission_completed" if !session_pending.is_empty() => {
                    session_pending.remove(0);
                }
                _ => {}
            }
        }
        pending.extend(session_pending);
    }
    pending
}

/// Answers `request_id` after checking it is current, the oldest in its session, in
/// `project_id`, and that its session is still running.
pub fn respond_to_mobile_permission<'a>(
    records: impl IntoIterator<Item = &'a MobileSessionRecord>,
    request_id: &str,
    project_id: &str,
    decision: MobilePermissionAnswer,
    has_active_task: impl FnOnce(&str) -> bool,
    respond: impl FnOnce(&str, PermissionDecision),
) -> Result<MobilePermissionResponse, String> {
    let pending = pending_mobile_permissions(records);
    let Some(request) = pending.iter().find(|c| c.request_id == request_id) else {
        return Err("That permission request is no longer pending.".to_owned());
    };
    let oldest = pending
        .iter()
        .find(|candidate| candidate.session_id == request.session_id);
    if oldest.map(|o| o.request_id.as_str()) != Some(request.request_id.as_str()) {
        return Err(
            "This session has an earlier permission request waiting. Answer that one first."
                .to_owned(),
        );
    }
    if request.project_id.as_deref() != Some(project_id) {
        return Err(format!(
            "That permission request is not in project {project_id}."
        ));
    }
    if !has_active_task(&request.session_key) {
        return Err("The session for that permission request is no longer active.".to_owned());
    }
    respond(&request.session_key, decision.into());
    Ok(MobilePermissionResponse {
        request_id: request.request_id.clone(),
        decision,
        session_id: request.session_id.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::session_record::{MobileSessionEventRecord as Event, MobileTaskDefinition};

    fn record(events: Vec<Event>) -> MobileSessionRecord {
        MobileSessionRecord {
            issue_key: "SESSION-1".into(),
            session_id: "s1".into(),
            project_id: Some("p1".into()),
            state: "awaiting_approval".into(),
            task_definition: MobileTaskDefinition {
                goal: "Help".into(),
            },
            events,
            started_at: "2026-09-22T09:00:00.000Z".into(),
            ..MobileSessionRecord::default()
        }
    }

    fn requested(at: &str, summary: &str) -> Event {
        Event::new(at, "permission_requested", summary)
    }

    #[test]
    fn identifies_the_exact_unresolved_permission_after_completed_requests() {
        let records = [record(vec![
            requested("2026-09-22T09:00:01.000Z", "Read file"),
            Event::new(
                "2026-09-22T09:00:02.000Z",
                "permission_completed",
                "Permission: allow",
            ),
            requested("2026-09-22T09:00:03.000Z", "Run tests").with_detail("npm test"),
        ])];
        let pending = pending_mobile_permissions(&records);
        assert_eq!(
            serde_json::to_string(&pending).expect("json"),
            r#"[{"requestId":"s1:permission:2","sessionId":"s1","sessionKey":"SESSION-1","projectId":"p1","summary":"Run tests","detail":"npm test","createdAt":"2026-09-22T09:00:03.000Z"}]"#
        );
    }

    #[test]
    fn dismisses_unresolved_history_once_the_session_no_longer_awaits_approval() {
        let events = vec![requested("2026-09-22T09:00:01.000Z", "Run tests")];
        assert_eq!(
            pending_mobile_permissions(&[record(events.clone())]).len(),
            1
        );
        for state in ["completed", "failed", "aborted"] {
            let mut stopped = record(events.clone());
            stopped.state = state.into();
            assert!(pending_mobile_permissions(&[stopped]).is_empty());
        }
    }

    #[test]
    fn responds_only_to_a_current_request_and_rejects_a_stale_id() {
        let records = [record(vec![requested(
            "2026-09-22T09:00:01.000Z",
            "Run tests",
        )])];
        let mut observed = None;
        let result = respond_to_mobile_permission(
            &records,
            "s1:permission:0",
            "p1",
            MobilePermissionAnswer::Deny,
            |_| true,
            |key, decision| observed = Some((key.to_owned(), decision)),
        )
        .expect("answered");
        assert_eq!(
            serde_json::to_value(&result).expect("json"),
            serde_json::json!({ "requestId": "s1:permission:0", "decision": "deny", "sessionId": "s1" })
        );
        assert_eq!(
            observed,
            Some(("SESSION-1".to_owned(), PermissionDecision::Deny))
        );
        let stale = respond_to_mobile_permission(
            &[record(vec![])],
            "s1:permission:0",
            "p1",
            MobilePermissionAnswer::Allow,
            |_| true,
            |_, _| {},
        );
        assert!(stale.expect_err("stale").contains("no longer pending"));
    }

    #[test]
    fn preserves_approve_all_as_allow_always() {
        let records = [record(vec![requested(
            "2026-09-22T09:00:01.000Z",
            "Run tests",
        )])];
        let mut observed = None;
        let result = respond_to_mobile_permission(
            &records,
            "s1:permission:0",
            "p1",
            MobilePermissionAnswer::AllowAlways,
            |_| true,
            |_, decision| observed = Some(decision),
        )
        .expect("answered");
        assert_eq!(result.decision, MobilePermissionAnswer::AllowAlways);
        assert_eq!(observed, Some(PermissionDecision::AllowAlways));
    }

    #[test]
    fn refuses_a_later_request_while_an_earlier_one_in_the_same_session_waits() {
        let records = [record(vec![
            requested("2026-09-22T09:00:01.000Z", "Run tests"),
            requested("2026-09-22T09:00:02.000Z", "Write file"),
        ])];
        let mut responded = false;
        let error = respond_to_mobile_permission(
            &records,
            "s1:permission:1",
            "p1",
            MobilePermissionAnswer::Allow,
            |_| true,
            |_, _| responded = true,
        )
        .expect_err("refused");
        assert!(error.contains("earlier permission request"));
        assert!(!responded);
    }

    #[test]
    fn refuses_another_project_and_an_inactive_session() {
        let records = [record(vec![requested(
            "2026-09-22T09:00:01.000Z",
            "Run tests",
        )])];
        let wrong_project = respond_to_mobile_permission(
            &records,
            "s1:permission:0",
            "p2",
            MobilePermissionAnswer::Allow,
            |_| true,
            |_, _| {},
        );
        assert_eq!(
            wrong_project,
            Err("That permission request is not in project p2.".into())
        );
        let inactive = respond_to_mobile_permission(
            &records,
            "s1:permission:0",
            "p1",
            MobilePermissionAnswer::Allow,
            |_| false,
            |_, _| {},
        );
        assert_eq!(
            inactive,
            Err("The session for that permission request is no longer active.".into())
        );
    }
}
