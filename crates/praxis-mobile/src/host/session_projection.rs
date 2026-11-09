//! An agent session as the phone shows it (`apps/praxis-desktop/main/src/main/mobileSessionProjection.ts`
//! port).
//!
//! Pure: a [`MobileSessionRecord`] in, a bounded summary or snapshot out, so a listing, a live
//! event and the tests all produce the same shape. A provider handover reaches the phone as its
//! one-line notice, never as the brief (which carries workspace paths); gadget fences become
//! gadgets resolved through an injected [`MobileGadgetResolver`].

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::gadget_text::{
    gadget_message_key, is_conversation_event, may_contain_gadget, streaming_text,
    strip_gadget_fences,
};
use super::js_text::{js_len, js_slice};
use super::ledger::MobileCommandLedger;
use super::permissions::pending_mobile_permissions;
use super::protocol::{MOBILE_PROTOCOL_VERSION, MobileEventEnvelope, MobileTarget, now_iso};
use super::session_record::{MobileSessionRecord, truthy};

const MAX_MOBILE_MESSAGES: usize = 80;
const MAX_MOBILE_MESSAGE_CHARS: usize = 8_000;
const MAX_MOBILE_REASONING_CHARS: usize = 4_000;
const MAX_MOBILE_RESPONSE_CHARS: usize = 12_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileSessionLifecycle {
    Idle,
    Active,
    AwaitingInput,
    Completed,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSessionSummary {
    pub session_id: String,
    pub session_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_key: Option<String>,
    pub title: String,
    pub lifecycle: MobileSessionLifecycle,
    /// Latest desktop event summary, bounded for the home activity line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_activity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub mode: String,
    pub archived: bool,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSessionMessage {
    pub id: String,
    /// `user` | `assistant` | `system`.
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gadgets: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Value>>,
    pub at: String,
    /// `complete` | `streaming` | `failed` | `stopped`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<Value>,
}

impl MobileSessionMessage {
    fn new(id: String, role: &str, text: String, at: String, status: &str) -> Self {
        Self {
            id,
            role: role.to_owned(),
            text,
            gadgets: None,
            attachments: None,
            at,
            status: status.to_owned(),
            reasoning: None,
            model: None,
            tool_names: None,
            token_usage: None,
            cost: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePendingPermission {
    pub request_id: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSessionSnapshot {
    #[serde(flatten)]
    pub summary: MobileSessionSummary,
    /// The host event sequence this snapshot is current as of; the higher one wins.
    pub sequence: u64,
    pub messages: Vec<MobileSessionMessage>,
    pub pending_permissions: Vec<MobilePendingPermission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<Value>,
    pub can_continue: bool,
    pub can_cancel: bool,
}

/// Resolves the gadgets an assistant message asked for, under the key the desktop publishes them
/// (`gadgetMessageKey`): `(session_id, message_key, text) -> (gadget views, unrendered count)`.
pub type MobileGadgetResolver<'a> = &'a dyn Fn(&str, &str, &str) -> (Vec<Value>, usize);

const UNRENDERED_NOTE: &str = "_A gadget in this message could not be shown on the phone. Open the session on the desktop to see it._";

fn bounded_text(value: &str, limit: usize) -> String {
    let length = js_len(value);
    if length <= limit {
        return value.to_owned();
    }
    let marker = "\n\n[…content truncated for mobile…]\n\n";
    let available = limit.saturating_sub(js_len(marker));
    // `Math.ceil(available * 0.6)`, in the same floating point as the TS.
    let head = ((available as f64) * 0.6).ceil() as usize;
    let tail = available - head;
    format!(
        "{}{marker}{}",
        js_slice(value, 0, head),
        js_slice(value, length - tail, length)
    )
}

fn lifecycle_for(record: &MobileSessionRecord) -> MobileSessionLifecycle {
    match record.state.as_str() {
        "planning" | "executing" => MobileSessionLifecycle::Active,
        "awaiting_approval" | "awaiting_input" | "paused" => MobileSessionLifecycle::AwaitingInput,
        "completed" => MobileSessionLifecycle::Completed,
        "failed" => MobileSessionLifecycle::Failed,
        "aborted" => MobileSessionLifecycle::Stopped,
        _ => MobileSessionLifecycle::Idle,
    }
}

pub fn mobile_session_summary(record: &MobileSessionRecord) -> MobileSessionSummary {
    let title = [
        record.title.as_deref().unwrap_or_default().trim(),
        record.task_definition.goal.trim(),
    ]
    .into_iter()
    .find(|candidate| !candidate.is_empty())
    .unwrap_or(&record.issue_key)
    .to_owned();
    let latest_activity = record
        .events
        .last()
        .map(|event| event.summary.trim())
        .filter(|summary| !summary.is_empty())
        .map(|summary| js_slice(summary, 0, 280));
    MobileSessionSummary {
        session_id: record.session_id.clone(),
        session_key: record.issue_key.clone(),
        project_id: truthy(&record.project_id).cloned(),
        work_id: (!record.issue_key.is_empty()).then(|| record.issue_key.clone()),
        run_id: truthy(&record.workflow_run_id).cloned(),
        parent_session_key: truthy(&record.parent_session_key).cloned(),
        title,
        lifecycle: lifecycle_for(record),
        latest_activity,
        provider: truthy(&record.provider).cloned(),
        model: truthy(&record.model).cloned(),
        mode: record.mode.clone().unwrap_or_else(|| "chat".to_owned()),
        archived: record.archived == Some(true),
        started_at: record.started_at.clone(),
        completed_at: truthy(&record.completed_at).cloned(),
    }
}

fn persisted_messages(
    record: &MobileSessionRecord,
    resolve_gadgets: Option<MobileGadgetResolver<'_>>,
) -> Vec<MobileSessionMessage> {
    let session = &record.session_id;
    let initial_goal = record.task_definition.goal.trim();
    let mut messages = Vec::new();
    if !initial_goal.is_empty() {
        messages.push(MobileSessionMessage::new(
            format!("{session}:initial"),
            "user",
            initial_goal.to_owned(),
            record.started_at.clone(),
            "complete",
        ));
    }
    // A handover brief carries workspace paths and transcript excerpts: the phone gets only the
    // event's one-line summary, and the brief's later user turn is skipped.
    let mut handover_briefs: Vec<String> = Vec::new();
    // Counted exactly as the desktop's conversation view counts, before any event is skipped.
    let mut conversation_index: i64 = -1;
    for (index, event) in record.events.iter().enumerate() {
        if is_conversation_event(&event.kind, event.detail.as_deref(), &event.summary) {
            conversation_index += 1;
        }
        if event.kind == "provider_handover" || event.kind == "model_change" {
            if event.kind == "provider_handover" {
                if let Some(brief) = event.detail().map(str::trim).filter(|b| !b.is_empty()) {
                    handover_briefs.push(brief.to_owned());
                }
            }
            messages.push(MobileSessionMessage::new(
                format!("{session}:event:{index}"),
                "system",
                event.summary.trim().to_owned(),
                event.timestamp.clone(),
                "complete",
            ));
            continue;
        }
        let role = match event.kind.as_str() {
            "user_input_completed" => "user",
            "message" => "assistant",
            "error" => "system",
            _ => continue,
        };
        let raw = event.detail().unwrap_or(&event.summary).trim();
        if raw.is_empty() {
            continue;
        }
        if role == "user" && event.gadget_answer == Some(true) {
            continue;
        }
        if role == "user" && handover_briefs.iter().any(|brief| brief == raw) {
            continue;
        }
        let has_attachments = event.attachments.as_ref().is_some_and(|a| !a.is_empty());
        if role == "user"
            && !has_attachments
            && messages
                .iter()
                .any(|message| message.role == "user" && message.text == raw)
        {
            continue;
        }
        let has_gadget = role == "assistant" && may_contain_gadget(raw);
        let (gadgets, unrendered) = match resolve_gadgets {
            Some(resolve) if has_gadget => {
                resolve(session, &gadget_message_key(conversation_index), raw)
            }
            _ => (Vec::new(), 0),
        };
        // The fences are drawn as gadgets; left in, the phone would show their JSON.
        let stripped = if has_gadget {
            strip_gadget_fences(raw)
        } else {
            raw.to_owned()
        };
        let text = if unrendered > 0 {
            [stripped.as_str(), UNRENDERED_NOTE]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n")
        } else {
            stripped
        };
        if text.is_empty() && gadgets.is_empty() {
            continue;
        }
        let mut message = MobileSessionMessage::new(
            format!("{session}:event:{index}"),
            role,
            bounded_text(&text, MAX_MOBILE_MESSAGE_CHARS),
            event.timestamp.clone(),
            if event.kind == "error" {
                "failed"
            } else {
                "complete"
            },
        );
        if !gadgets.is_empty() {
            message.gadgets = Some(gadgets);
        }
        if event.kind == "user_input_completed" && has_attachments {
            message.attachments = event.attachments.as_ref().map(|attachments| {
                attachments
                    .iter()
                    .enumerate()
                    .map(|(attachment_index, attachment)| {
                        json!({
                            "eventIndex": index,
                            "attachmentIndex": attachment_index,
                            "mimeType": attachment.get("mimeType").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect()
            });
        }
        message.reasoning = truthy(&event.reasoning)
            .map(|reasoning| bounded_text(reasoning, MAX_MOBILE_REASONING_CHARS));
        message.model = truthy(&event.model_id).cloned();
        message.tool_names = event.tool_names.clone().filter(|names| !names.is_empty());
        message.token_usage = event.token_usage.clone().filter(is_truthy);
        message.cost = event.cost.clone().filter(is_truthy);
        messages.push(message);
    }
    keep_last(&mut messages);
    messages
}

fn is_truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false))
}

fn keep_last(messages: &mut Vec<MobileSessionMessage>) {
    if messages.len() > MAX_MOBILE_MESSAGES {
        messages.drain(..messages.len() - MAX_MOBILE_MESSAGES);
    }
}

/// The session's snapshot. `sequence` defaults (in the TS) to the event count; pass it.
pub fn mobile_session_snapshot(
    record: &MobileSessionRecord,
    sequence: u64,
    resolve_gadgets: Option<MobileGadgetResolver<'_>>,
) -> MobileSessionSnapshot {
    let summary = mobile_session_summary(record);
    let mut messages = persisted_messages(record, resolve_gadgets);
    let active = matches!(
        summary.lifecycle,
        MobileSessionLifecycle::Active | MobileSessionLifecycle::AwaitingInput
    );
    let response_text = record
        .response_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(streaming_text);
    let reasoning_text = record
        .reasoning_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let pending_permissions = pending_mobile_permissions([record])
        .into_iter()
        .map(|request| MobilePendingPermission {
            request_id: request.request_id,
            summary: request.summary,
            detail: request.detail,
            created_at: request.created_at,
        })
        .collect();
    if let Some(response) = response_text
        .as_deref()
        .filter(|text| active && !text.is_empty())
    {
        let duplicate = messages
            .last()
            .is_some_and(|last| last.role == "assistant" && last.text == response);
        if !duplicate {
            let mut message = MobileSessionMessage::new(
                format!("{}:active", record.session_id),
                "assistant",
                bounded_text(response, MAX_MOBILE_RESPONSE_CHARS),
                now_iso(),
                "streaming",
            );
            message.reasoning =
                reasoning_text.map(|text| bounded_text(text, MAX_MOBILE_REASONING_CHARS));
            message.model = truthy(&record.model).cloned();
            message.token_usage = record.token_usage.clone().filter(is_truthy);
            message.cost = record.cost.clone().filter(is_truthy);
            messages.push(message);
        }
    }
    keep_last(&mut messages);
    MobileSessionSnapshot {
        sequence,
        messages,
        pending_permissions,
        response_text: response_text
            .as_deref()
            .filter(|text| active && !text.is_empty())
            .map(|text| bounded_text(text, MAX_MOBILE_RESPONSE_CHARS)),
        reasoning_text: reasoning_text
            .filter(|_| active)
            .map(|text| bounded_text(text, MAX_MOBILE_REASONING_CHARS)),
        token_usage: record.token_usage.clone().filter(is_truthy),
        context_tokens: record.context_tokens.clone().filter(|v| !v.is_null()),
        context_limit: record.context_limit.clone().filter(|v| !v.is_null()),
        cost: record.cost.clone().filter(is_truthy),
        can_continue: !active && record.archived != Some(true),
        can_cancel: active,
        summary,
    }
}

fn append(
    ledger: &dyn MobileCommandLedger,
    event_id: impl FnOnce(u64) -> String,
    target: MobileTarget,
    event: impl FnOnce(u64) -> Value,
) -> u64 {
    let sequence = ledger.latest_sequence() + 1;
    ledger.append_event(MobileEventEnvelope {
        protocol_version: MOBILE_PROTOCOL_VERSION,
        event_id: event_id(sequence),
        sequence,
        emitted_at: now_iso(),
        target,
        event: event(sequence),
    });
    sequence
}

/// Appends a session change as a full snapshot stamped with its own sequence — what the desktop
/// does on every session change, and what a phone replays after reconnecting.
pub fn append_mobile_session_event(
    ledger: &dyn MobileCommandLedger,
    host_id: &str,
    record: &MobileSessionRecord,
    resolve_gadgets: Option<MobileGadgetResolver<'_>>,
) -> u64 {
    let target = MobileTarget {
        host_id: host_id.to_owned(),
        project_id: truthy(&record.project_id).cloned(),
        session_id: Some(record.session_id.clone()),
        run_id: truthy(&record.workflow_run_id).cloned(),
        request_id: None,
    };
    append(
        ledger,
        |sequence| format!("{}:{sequence}", record.session_id),
        target,
        |sequence| {
            json!({
                "type": "session.snapshot",
                "snapshot": mobile_session_snapshot(record, sequence, resolve_gadgets),
            })
        },
    )
}

/// Appends a theme change: host-wide, so every paired phone gets it whatever projects it has.
/// `appearance` is the already-normalised `MobileAppearance`.
pub fn append_mobile_appearance_event(
    ledger: &dyn MobileCommandLedger,
    host_id: &str,
    appearance: &Value,
) -> u64 {
    append(
        ledger,
        |sequence| format!("appearance:{sequence}"),
        MobileTarget::host(host_id),
        |_| json!({ "type": "host.appearance", "appearance": appearance }),
    )
}

#[cfg(test)]
mod tests;
