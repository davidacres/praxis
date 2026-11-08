//! Deterministic state transitions for durable team chat conversations (`transitions.rs`).

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

use super::types::{
    ConversationAttempt, ConversationAttemptState, ConversationCommandReceipt,
    ConversationContextReceipt, ConversationMessage, ConversationRecoveryEvidence,
    ConversationTurn, ConversationTurnState, DurableConversation,
};

/// Computes the canonical SHA-256 digest of a JSON command payload.
/// Object keys are sorted lexicographically to guarantee stable canonical digests.
pub fn conversation_payload_digest(payload: &Value) -> Result<String, String> {
    fn canonical(value: &Value) -> Result<String, String> {
        match value {
            Value::Null => Ok("null".to_string()),
            Value::Bool(b) => Ok(if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }),
            Value::Number(n) => Ok(n.to_string()),
            Value::String(s) => Ok(serde_json::to_string(s).unwrap_or_default()),
            Value::Array(arr) => {
                let items: Result<Vec<String>, String> = arr.iter().map(canonical).collect();
                Ok(format!("[{}]", items?.join(",")))
            }
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let mut entries = Vec::new();
                for k in keys {
                    let v = &map[k];
                    let key_json = serde_json::to_string(k).unwrap_or_default();
                    let val_canon = canonical(v)?;
                    entries.push(format!("{key_json}:{val_canon}"));
                }
                Ok(format!("{{{}}}", entries.join(",")))
            }
        }
    }

    let canon = canonical(payload)?;
    let mut hasher = Sha256::new();
    hasher.update(canon.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

fn check_revision(current: &DurableConversation, expected: u64) -> Result<(), String> {
    if current.revision != expected {
        return Err(format!(
            "Conversation revision conflict: current is {}, expected is {expected}",
            current.revision
        ));
    }
    Ok(())
}

fn prepare_change(
    current: &DurableConversation,
    expected: u64,
) -> Result<DurableConversation, String> {
    check_revision(current, expected)?;
    let mut next = current.clone();
    next.revision += 1;
    Ok(next)
}

/// Atomically submits a new conversation turn with idempotency protection.
pub fn submit_conversation_turn(
    current: &DurableConversation,
    expected_revision: u64,
    payload: &Value,
    turn: &ConversationTurn,
    message: &ConversationMessage,
) -> Result<DurableConversation, String> {
    let digest = conversation_payload_digest(payload)?;

    // Idempotency check against historical command receipts
    if let Some(receipt) = current
        .command_receipts
        .iter()
        .find(|r| r.command_id == turn.command_id)
    {
        if receipt.payload_digest != digest {
            return Err("Command payload conflict.".to_string());
        }
        return Ok(current.clone());
    }

    let mut next = prepare_change(current, expected_revision)?;

    // Invariant validation
    if turn.state != ConversationTurnState::Queued
        || !turn.attempts.is_empty()
        || !turn.completed_participant_ids.is_empty()
        || turn.payload_digest != digest
        || turn.user_message_id != message.id
        || message.turn_id != turn.id
        || message.role != "user"
        || message.participant_id.is_some()
    {
        return Err("Invalid accepted turn.".to_string());
    }

    let last_seq = current.messages.last().map(|m| m.sequence).unwrap_or(0);
    if message.sequence != last_seq + 1 || turn.accepted_sequence != message.sequence {
        return Err("Turn message sequence mismatch.".to_string());
    }

    if current.turns.iter().any(|t| t.id == turn.id)
        || current.messages.iter().any(|m| m.id == message.id)
    {
        return Err("Duplicate turn or message ID.".to_string());
    }

    if turn.plan.participants.is_empty() {
        return Err("Turn plan must have at least one participant.".to_string());
    }

    let p_ids: HashSet<&String> = turn.plan.participants.iter().map(|p| &p.id).collect();
    if p_ids.len() != turn.plan.participants.len() {
        return Err("Duplicate participant IDs in turn plan.".to_string());
    }

    next.turns.push(turn.clone());
    next.messages.push(message.clone());
    next.command_receipts.push(ConversationCommandReceipt {
        command_id: turn.command_id.clone(),
        payload_digest: digest,
        turn_id: turn.id.clone(),
        revision: next.revision,
        outcome: "accepted".to_string(),
    });

    Ok(next)
}

/// Starts the next queued conversation turn.
pub fn start_conversation_turn(
    current: &DurableConversation,
    expected_revision: u64,
    turn_id: &str,
) -> Result<DurableConversation, String> {
    let mut next = prepare_change(current, expected_revision)?;

    if next.turns.iter().any(|t| {
        !matches!(
            t.state,
            ConversationTurnState::Queued
                | ConversationTurnState::Completed
                | ConversationTurnState::Cancelled
        )
    }) {
        return Err("Conversation already has an active or paused turn.".to_string());
    }

    let turn = next
        .turns
        .iter_mut()
        .find(|t| t.state == ConversationTurnState::Queued)
        .ok_or_else(|| "No queued turn found".to_string())?;

    if turn.id != turn_id {
        return Err(format!("Turn {turn_id} is not the next queued turn"));
    }

    turn.state = ConversationTurnState::Running;
    Ok(next)
}

/// Reserves a prepared attempt for a participant in the running turn.
pub fn reserve_conversation_attempt(
    current: &DurableConversation,
    expected_revision: u64,
    attempt: &ConversationAttempt,
) -> Result<DurableConversation, String> {
    let mut next = prepare_change(current, expected_revision)?;

    let turn = next
        .turns
        .iter_mut()
        .find(|t| t.id == attempt.turn_id)
        .ok_or_else(|| format!("Turn {} not found", attempt.turn_id))?;

    if turn.state != ConversationTurnState::Running {
        return Err("Turn is not running.".to_string());
    }

    let next_participant = turn
        .plan
        .participants
        .iter()
        .find(|p| !turn.completed_participant_ids.contains(&p.id))
        .ok_or_else(|| "All participants have already completed".to_string())?;

    if next_participant.id != attempt.participant_id {
        return Err(format!(
            "Attempt participant {} does not match next planned participant {}",
            attempt.participant_id, next_participant.id
        ));
    }

    if attempt.coordinator_epoch != current.coordinator_epoch {
        return Err("Attempt coordinator epoch fenced.".to_string());
    }

    if attempt.state != ConversationAttemptState::Prepared {
        return Err("Reserved attempt must be in Prepared state.".to_string());
    }

    let prior_attempts_for_part = turn
        .attempts
        .iter()
        .filter(|a| a.participant_id == attempt.participant_id)
        .count() as u64;

    if attempt.ordinal != prior_attempts_for_part + 1 {
        return Err(format!(
            "Attempt ordinal mismatch: got {}, expected {}",
            attempt.ordinal,
            prior_attempts_for_part + 1
        ));
    }

    if turn.attempts.iter().any(|a| {
        !matches!(
            a.state,
            ConversationAttemptState::Completed
                | ConversationAttemptState::Failed
                | ConversationAttemptState::Interrupted
                | ConversationAttemptState::OutcomeUnknown
                | ConversationAttemptState::Cancelled
        )
    }) {
        return Err("Turn has an existing active attempt.".to_string());
    }

    turn.attempts.push(attempt.clone());
    Ok(next)
}

/// Advances dispatch evidence of an attempt without modifying the immutable plan.
pub fn advance_conversation_attempt(
    current: &DurableConversation,
    expected_revision: u64,
    turn_id: &str,
    attempt_id: &str,
    epoch: &str,
    target_state: ConversationAttemptState,
    timestamp: &str,
) -> Result<DurableConversation, String> {
    let mut next = prepare_change(current, expected_revision)?;

    let turn = next
        .turns
        .iter_mut()
        .find(|t| t.id == turn_id)
        .ok_or_else(|| "Turn not found".to_string())?;

    if turn.state != ConversationTurnState::Running {
        return Err("Turn is not running.".to_string());
    }

    let attempt = turn
        .attempts
        .iter_mut()
        .find(|a| a.id == attempt_id)
        .ok_or_else(|| "Attempt not found".to_string())?;

    if epoch != current.coordinator_epoch || epoch != attempt.coordinator_epoch {
        return Err("Fenced attempt transition: epoch mismatch.".to_string());
    }

    let allowed = match attempt.state {
        ConversationAttemptState::Prepared => target_state == ConversationAttemptState::Dispatching,
        ConversationAttemptState::Dispatching => target_state == ConversationAttemptState::Running,
        ConversationAttemptState::Running => {
            target_state == ConversationAttemptState::AwaitingApproval
        }
        ConversationAttemptState::AwaitingApproval => {
            target_state == ConversationAttemptState::Running
        }
        _ => false,
    };

    if !allowed {
        return Err(format!(
            "Invalid attempt transition from {:?} to {:?}",
            attempt.state, target_state
        ));
    }

    attempt.state = target_state;
    if target_state == ConversationAttemptState::Dispatching {
        attempt.dispatch_intent = Some(timestamp.to_string());
    }

    Ok(next)
}

/// Records a pending permission request an attempt is blocked on.
pub fn record_attempt_approval(
    current: &DurableConversation,
    expected_revision: u64,
    turn_id: &str,
    attempt_id: &str,
    epoch: &str,
    runtime_request_id: &str,
    timestamp: &str,
) -> Result<DurableConversation, String> {
    let mut next = prepare_change(current, expected_revision)?;

    let turn = next
        .turns
        .iter_mut()
        .find(|t| t.id == turn_id)
        .ok_or_else(|| "Turn not found".to_string())?;

    let attempt = turn
        .attempts
        .iter_mut()
        .find(|a| a.id == attempt_id)
        .ok_or_else(|| "Attempt not found".to_string())?;

    if epoch != current.coordinator_epoch
        || epoch != attempt.coordinator_epoch
        || attempt.state != ConversationAttemptState::Running
    {
        return Err("Invalid or fenced approval request.".to_string());
    }

    attempt.state = ConversationAttemptState::AwaitingApproval;
    attempt.pending_approval = Some(super::types::ConversationPendingApproval {
        runtime_request_id: runtime_request_id.to_string(),
        requested_at: timestamp.to_string(),
        coordinator_epoch: epoch.to_string(),
        status: "pending".to_string(),
        restored_epoch: None,
    });

    Ok(next)
}

/// Resolves a pending approval for a running attempt.
pub fn resolve_attempt_approval(
    current: &DurableConversation,
    expected_revision: u64,
    turn_id: &str,
    attempt_id: &str,
    epoch: &str,
    runtime_request_id: &str,
) -> Result<DurableConversation, String> {
    let mut next = prepare_change(current, expected_revision)?;

    let turn = next
        .turns
        .iter_mut()
        .find(|t| t.id == turn_id)
        .ok_or_else(|| "Turn not found".to_string())?;

    let attempt = turn
        .attempts
        .iter_mut()
        .find(|a| a.id == attempt_id)
        .ok_or_else(|| "Attempt not found".to_string())?;

    if epoch != current.coordinator_epoch
        || epoch != attempt.coordinator_epoch
        || attempt.state != ConversationAttemptState::AwaitingApproval
    {
        return Err("Invalid or fenced approval resolution.".to_string());
    }

    let Some(ref mut pending) = attempt.pending_approval else {
        return Err("No pending approval found on attempt".to_string());
    };

    if pending.status != "pending" || pending.runtime_request_id != runtime_request_id {
        return Err("Approval resolution ID or status mismatch".to_string());
    }

    pending.status = "resolved".to_string();
    attempt.state = ConversationAttemptState::Running;

    Ok(next)
}

/// Completes an attempt, stores the final message, and completes the turn if all participants finished.
pub fn complete_conversation_attempt(
    current: &DurableConversation,
    expected_revision: u64,
    turn_id: &str,
    attempt_id: &str,
    epoch: &str,
    message: &ConversationMessage,
    receipt: &ConversationContextReceipt,
) -> Result<DurableConversation, String> {
    let mut next = prepare_change(current, expected_revision)?;

    let turn = next
        .turns
        .iter_mut()
        .find(|t| t.id == turn_id)
        .ok_or_else(|| "Turn not found".to_string())?;

    let attempt = turn
        .attempts
        .iter_mut()
        .find(|a| a.id == attempt_id)
        .ok_or_else(|| "Attempt not found".to_string())?;

    if epoch != attempt.coordinator_epoch
        || turn.state != ConversationTurnState::Running
        || epoch != current.coordinator_epoch
        || (attempt.state != ConversationAttemptState::Running
            && attempt.state != ConversationAttemptState::AwaitingApproval)
        || attempt.dispatch_intent.is_none()
    {
        return Err("Invalid or fenced completion.".to_string());
    }

    if let Some(ref mut pa) = attempt.pending_approval {
        if pa.status == "pending" {
            pa.status = "resolved".to_string();
        }
    }

    attempt.context_receipt = receipt.clone();
    attempt.state = ConversationAttemptState::Completed;
    attempt.result_message_id = Some(message.id.clone());
    attempt.completed_at = Some(message.created_at.clone());

    turn.completed_participant_ids
        .push(attempt.participant_id.clone());

    let skipped_count = turn
        .skipped_participant_ids
        .as_ref()
        .map(|s| s.len())
        .unwrap_or(0);
    if turn.completed_participant_ids.len() + skipped_count >= turn.plan.participants.len() {
        turn.state = ConversationTurnState::Completed;
    } else {
        turn.state = ConversationTurnState::Running;
    }

    next.messages.push(message.clone());
    Ok(next)
}

/// Begins a new coordinator epoch, fencing in-flight attempts conservatively.
pub fn begin_conversation_epoch(
    current: &DurableConversation,
    expected_revision: u64,
    epoch: &str,
    timestamp: &str,
) -> Result<DurableConversation, String> {
    let mut next = prepare_change(current, expected_revision)?;

    if epoch.is_empty() || epoch == current.coordinator_epoch {
        return Err("A fresh coordinator epoch is required.".to_string());
    }

    next.coordinator_epoch = epoch.to_string();

    for turn in &mut next.turns {
        for attempt in &mut turn.attempts {
            if matches!(
                attempt.state,
                ConversationAttemptState::Prepared
                    | ConversationAttemptState::Dispatching
                    | ConversationAttemptState::Running
                    | ConversationAttemptState::AwaitingApproval
            ) {
                if let Some(ref mut pa) = attempt.pending_approval {
                    if pa.status == "pending" {
                        pa.status = "invalidated".to_string();
                    }
                }

                let was_dispatched = attempt.dispatch_intent.is_some();
                let stopped = turn.state == ConversationTurnState::Cancelling;

                attempt.state = if was_dispatched {
                    ConversationAttemptState::OutcomeUnknown
                } else if stopped {
                    ConversationAttemptState::Cancelled
                } else {
                    ConversationAttemptState::Interrupted
                };

                attempt.completed_at = Some(timestamp.to_string());

                let mut data_map = std::collections::BTreeMap::new();
                data_map.insert("dispatched".to_string(), Value::Bool(was_dispatched));

                let evidence = ConversationRecoveryEvidence {
                    id: format!("recovery:{epoch}:{}", attempt.id),
                    conversation_id: next.id.clone(),
                    turn_id: turn.id.clone(),
                    participant_id: attempt.participant_id.clone(),
                    attempt_id: attempt.id.clone(),
                    coordinator_epoch: attempt.coordinator_epoch.clone(),
                    observing_epoch: Some(epoch.to_string()),
                    kind: "reconciliation".to_string(),
                    observed_at: timestamp.to_string(),
                    provenance: "coordinator-startup".to_string(),
                    data: Some(data_map),
                };

                attempt
                    .recovery_evidence
                    .get_or_insert_with(Vec::new)
                    .push(evidence);

                turn.state = match attempt.state {
                    ConversationAttemptState::OutcomeUnknown => {
                        ConversationTurnState::OutcomeUnknown
                    }
                    ConversationAttemptState::Cancelled => ConversationTurnState::Cancelled,
                    _ => ConversationTurnState::Interrupted,
                };
            }
        }
    }

    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_chat::types::{AssistantRole, ConversationParticipant, ConversationTurnPlan};
    use serde_json::json;
    use std::collections::BTreeMap;

    fn create_test_conversation() -> DurableConversation {
        DurableConversation {
            schema_version: 2,
            id: "conv-1".to_string(),
            title: "Test Conversation".to_string(),
            project_id: Some("proj-1".to_string()),
            issue_key: Some("PRX-1".to_string()),
            created_at: "2026-11-08T12:00:00Z".to_string(),
            updated_at: "2026-11-08T12:00:00Z".to_string(),
            archived: None,
            revision: 0,
            coordinator_epoch: "epoch-1".to_string(),
            participants: vec![ConversationParticipant {
                id: "part-lead".to_string(),
                role: AssistantRole::Lead,
                instruction_version: "v1".to_string(),
                instructions: "Lead prompt".to_string(),
                defaults: BTreeMap::new(),
            }],
            messages: Vec::new(),
            turns: Vec::new(),
            bindings: Vec::new(),
            summaries: Vec::new(),
            pinned_message_ids: Vec::new(),
            command_receipts: Vec::new(),
        }
    }

    #[test]
    fn canonical_payload_digest_sorts_keys_deterministically() {
        let payload1 = json!({ "b": 2, "a": 1, "nested": { "z": true, "x": "hello" } });
        let payload2 = json!({ "nested": { "x": "hello", "z": true }, "a": 1, "b": 2 });

        let digest1 = conversation_payload_digest(&payload1).expect("digest 1");
        let digest2 = conversation_payload_digest(&payload2).expect("digest 2");

        assert_eq!(digest1, digest2);
        assert_eq!(digest1.len(), 64);
    }

    #[test]
    fn turn_submission_is_idempotent_for_matching_payload_and_conflicts_on_different() {
        let conv = create_test_conversation();
        let payload = json!({ "text": "Plan architecture" });
        let digest = conversation_payload_digest(&payload).expect("digest");

        let message = ConversationMessage {
            id: "msg-1".to_string(),
            role: "user".to_string(),
            text: "Plan architecture".to_string(),
            created_at: "2026-11-08T12:01:00Z".to_string(),
            sequence: 1,
            turn_id: "turn-1".to_string(),
            participant_id: None,
            attachments: vec![],
            context: None,
            error: None,
        };

        let turn = ConversationTurn {
            id: "turn-1".to_string(),
            command_id: "cmd-1".to_string(),
            payload_digest: digest.clone(),
            user_message_id: "msg-1".to_string(),
            accepted_sequence: 1,
            plan: ConversationTurnPlan {
                participants: conv.participants.clone(),
                runtime_options: BTreeMap::new(),
                context: None,
            },
            state: ConversationTurnState::Queued,
            context_required_reason: None,
            completed_participant_ids: vec![],
            skipped_participant_ids: None,
            attempts: vec![],
        };

        let submitted =
            submit_conversation_turn(&conv, 0, &payload, &turn, &message).expect("turn submitted");
        assert_eq!(submitted.revision, 1);
        assert_eq!(submitted.turns.len(), 1);
        assert_eq!(submitted.command_receipts.len(), 1);

        // Idempotent resubmission with matching payload
        let resubmitted = submit_conversation_turn(&submitted, 1, &payload, &turn, &message)
            .expect("idempotent replay");
        assert_eq!(resubmitted.revision, 1);
        assert_eq!(resubmitted.turns.len(), 1);

        // Resubmission with conflicting payload fails
        let conflict_payload = json!({ "text": "Different text" });
        let conflict_err =
            submit_conversation_turn(&submitted, 1, &conflict_payload, &turn, &message)
                .expect_err("conflicting payload must be rejected");
        assert_eq!(conflict_err, "Command payload conflict.");
    }

    #[test]
    fn epoch_fences_active_attempts_to_outcome_unknown_on_crash_recovery() {
        let mut conv = create_test_conversation();
        conv.revision = 2;

        let attempt = ConversationAttempt {
            id: "att-1".to_string(),
            turn_id: "turn-1".to_string(),
            participant_id: "part-lead".to_string(),
            ordinal: 1,
            coordinator_epoch: "epoch-1".to_string(),
            state: ConversationAttemptState::Running,
            binding_id: None,
            provider_session_id: None,
            native_context_receipt: None,
            context_receipt: ConversationContextReceipt::default(),
            dispatch_intent: Some("2026-11-08T12:02:00Z".to_string()),
            created_at: "2026-11-08T12:02:00Z".to_string(),
            completed_at: None,
            error: None,
            result_message_id: None,
            reported_cost: None,
            usage: None,
            usage_references: vec![],
            tool_evidence_references: vec![],
            recovery_evidence: None,
            pending_approval: None,
        };

        let turn = ConversationTurn {
            id: "turn-1".to_string(),
            command_id: "cmd-1".to_string(),
            payload_digest: "digest".to_string(),
            user_message_id: "msg-1".to_string(),
            accepted_sequence: 1,
            plan: ConversationTurnPlan {
                participants: conv.participants.clone(),
                runtime_options: BTreeMap::new(),
                context: None,
            },
            state: ConversationTurnState::Running,
            context_required_reason: None,
            completed_participant_ids: vec![],
            skipped_participant_ids: None,
            attempts: vec![attempt],
        };

        conv.turns.push(turn);

        // Crash recovery: start new epoch
        let recovered = begin_conversation_epoch(&conv, 2, "epoch-2", "2026-11-08T12:05:00Z")
            .expect("epoch change succeeds");

        assert_eq!(recovered.coordinator_epoch, "epoch-2");
        assert_eq!(recovered.revision, 3);

        let recovered_attempt = &recovered.turns[0].attempts[0];
        assert_eq!(
            recovered_attempt.state,
            ConversationAttemptState::OutcomeUnknown
        );
        assert_eq!(
            recovered_attempt.coordinator_epoch,
            "epoch-1" // Preserves originating epoch
        );

        let evidence = recovered_attempt
            .recovery_evidence
            .as_ref()
            .expect("recovery evidence");
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].observing_epoch, Some("epoch-2".to_string()));
        assert_eq!(evidence[0].coordinator_epoch, "epoch-1");
    }
}
