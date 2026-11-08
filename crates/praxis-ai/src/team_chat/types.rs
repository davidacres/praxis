//! Domain types for durable team chat conversations.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// The five specialist seats on the virtual engineering team.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssistantRole {
    Lead,
    Dev,
    Qa,
    Security,
    Product,
}

/// Author of a message in a team chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssistantSpeaker {
    User,
    #[serde(untagged)]
    Role(AssistantRole),
}

/// Page context the assistant was invoked against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PageAssistantContext {
    pub page_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
    pub title: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_prompts: Option<Vec<String>>,
}

/// Virtual persona configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPersona {
    pub id: AssistantRole,
    pub name: String,
    pub badge: String,
    pub role: AssistantRole,
    pub icon: String,
    pub tone: AssistantRole,
    pub system_prompt: String,
}

/// Standard assistant message in chat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    pub id: String,
    pub role: String, // "user", "lead", "dev", "qa", "security", "product"
    pub text: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}

/// Attachment reference in a conversation message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAttachment {
    pub id: String,
    pub digest: String,
    pub media_type: String,
    pub size: u64,
}

/// Immutable ordered message in a durable conversation transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub created_at: String,
    pub sequence: u64,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participant_id: Option<String>,
    #[serde(default)]
    pub attachments: Vec<ConversationAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<PageAssistantContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationTurnState {
    Queued,
    Running,
    Completed,
    AwaitingApproval,
    ContextRequired,
    Failed,
    Interrupted,
    OutcomeUnknown,
    Cancelling,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationAttemptState {
    Prepared,
    Dispatching,
    Running,
    AwaitingApproval,
    Completed,
    Failed,
    Interrupted,
    OutcomeUnknown,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationParticipant {
    pub id: String,
    pub role: AssistantRole,
    pub instruction_version: String,
    pub instructions: String,
    #[serde(default)]
    pub defaults: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContextReceipt {
    pub digest: String,
    pub message_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPendingApproval {
    pub runtime_request_id: String,
    pub requested_at: String,
    pub coordinator_epoch: String,
    pub status: String, // "pending", "invalidated", "restored", "resolved"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored_epoch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRecoveryEvidence {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub participant_id: String,
    pub attempt_id: String,
    pub coordinator_epoch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observing_epoch: Option<String>,
    pub kind: String, // "partial_output", "tool_activity", "final_result", "runtime_identity", "reconciliation", "decision"
    pub observed_at: String,
    pub provenance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAttempt {
    pub id: String,
    pub turn_id: String,
    pub participant_id: String,
    pub ordinal: u64,
    pub coordinator_epoch: String,
    pub state: ConversationAttemptState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_context_receipt: Option<ConversationContextReceipt>,
    pub context_receipt: ConversationContextReceipt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_intent: Option<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_cost: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(default)]
    pub usage_references: Vec<String>,
    #[serde(default)]
    pub tool_evidence_references: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_evidence: Option<Vec<ConversationRecoveryEvidence>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_approval: Option<ConversationPendingApproval>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurnPlan {
    pub participants: Vec<ConversationParticipant>,
    #[serde(default)]
    pub runtime_options: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<PageAssistantContext>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurn {
    pub id: String,
    pub command_id: String,
    pub payload_digest: String,
    pub user_message_id: String,
    pub accepted_sequence: u64,
    pub plan: ConversationTurnPlan,
    pub state: ConversationTurnState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_required_reason: Option<String>,
    #[serde(default)]
    pub completed_participant_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped_participant_ids: Option<Vec<String>>,
    #[serde(default)]
    pub attempts: Vec<ConversationAttempt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationBinding {
    pub id: String,
    pub conversation_id: String,
    pub participant_id: String,
    pub provider_runtime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    pub compatibility_digest: String,
    #[serde(default)]
    pub delivered_message_ids: Vec<String>,
    #[serde(default)]
    pub native_output_message_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summarized_message_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_id: Option<String>,
    pub status: String, // "valid" | "invalid"
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_message_ids: Option<Vec<String>>,
    pub id: String,
    pub version: u64,
    pub source_start: u64,
    pub source_end: u64,
    pub source_digest: String,
    pub text: String,
    pub attempt_id: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCommandReceipt {
    pub command_id: String,
    pub payload_digest: String,
    pub turn_id: String,
    pub revision: u64,
    pub outcome: String, // "accepted"
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableConversation {
    pub schema_version: u32, // Must be 2
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    pub revision: u64,
    pub coordinator_epoch: String,
    #[serde(default)]
    pub participants: Vec<ConversationParticipant>,
    #[serde(default)]
    pub messages: Vec<ConversationMessage>,
    #[serde(default)]
    pub turns: Vec<ConversationTurn>,
    #[serde(default)]
    pub bindings: Vec<ConversationBinding>,
    #[serde(default)]
    pub summaries: Vec<ConversationSummary>,
    #[serde(default)]
    pub pinned_message_ids: Vec<String>,
    #[serde(default)]
    pub command_receipts: Vec<ConversationCommandReceipt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamChatRecord {
    pub id: String,
    pub project_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    pub messages: Vec<AssistantMessage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamChatSnapshot {
    pub schema_version: u32,
    pub revision: u64,
    #[serde(default)]
    pub team_chats: Vec<TeamChatRecord>,
    #[serde(default)]
    pub conversations: Vec<DurableConversation>,
}
