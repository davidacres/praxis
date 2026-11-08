//! The OpenAI-compatible chat wire format.
//!
//! Praxis talks to most providers through an OpenAI-compatible endpoint, and
//! the adapters that speak something else (Anthropic, Gemini) translate to and
//! from these shapes. Keeping the shared shapes in one place means a custom
//! endpoint provider and a first-party one are described the same way.

use serde::{Deserialize, Serialize};

/// Who is speaking in a chat turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireRole {
    System,
    User,
    Assistant,
    Tool,
}

/// The function a tool call asks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAiToolCallFunction {
    pub name: String,
    /// The arguments, JSON-encoded as a string.
    pub arguments: String,
}

/// A tool call on an assistant turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAiToolCall {
    pub id: String,
    /// Always `function`; kept so the shape round-trips unchanged.
    #[serde(rename = "type")]
    pub kind: String,
    pub function: OpenAiToolCallFunction,
}

impl OpenAiToolCall {
    /// A function call with the given id, name and JSON-encoded arguments.
    #[must_use]
    pub fn function(
        id: impl Into<String>,
        name: impl Into<String>,
        arguments: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            kind: "function".to_string(),
            function: OpenAiToolCallFunction {
                name: name.into(),
                arguments: arguments.into(),
            },
        }
    }
}

/// An image attached to a user turn — pasted or dropped into the composer.
///
/// Carried on the canonical message itself (not a separate side channel) so it
/// survives history compaction and rides along with the rest of that turn's
/// history the same as persisted text content already does; each provider
/// adapter is responsible for translating it into its own wire shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireImageAttachment {
    /// e.g. `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
    pub mime_type: String,
    /// Base64-encoded image bytes — no `data:` prefix.
    pub data_base64: String,
}

/// One turn of the conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireMessage {
    pub role: WireRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<OpenAiToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Only ever populated on a `role: 'user'` message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<WireImageAttachment>>,
}

impl WireMessage {
    /// A turn with no tool calls and no images.
    #[must_use]
    pub fn text(role: WireRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
            images: None,
        }
    }
}

/// A tool the model may call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayToolDefinition {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
}

/// A tool call the model asked for, with its arguments already parsed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Tokens a turn consumed, when the provider reports them.
///
/// Both wire formats carry this and neither is guessed at: OpenAI-compatible
/// streams send a final chunk with `usage` (the request already asks for it via
/// `stream_options.include_usage`), and Anthropic sends input tokens on
/// `message_start` and output tokens on `message_delta`. A provider that
/// reports nothing yields no usage at all rather than a zero, so "not reported"
/// and "genuinely zero" stay distinguishable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
}

impl TokenUsage {
    /// Fills in a total when the provider reported only the parts.
    #[must_use]
    pub fn with_derived_total(self) -> Self {
        if self.total_tokens.is_some() {
            return self;
        }
        if self.input_tokens.is_none() && self.output_tokens.is_none() {
            return self;
        }
        Self {
            total_tokens: Some(self.input_tokens.unwrap_or(0) + self.output_tokens.unwrap_or(0)),
            ..self
        }
    }
}

/// The result of one completed turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionResult {
    pub text: String,
    #[serde(rename = "toolCalls")]
    pub tool_calls: Vec<ChatCompletionToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
}

/// One event from a streaming chat.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamChatEvent {
    /// A piece of the answer.
    TextDelta { text: String },
    /// A piece of the model's reasoning.
    ThoughtDelta { text: String },
    /// A piece of a tool call, keyed by its position in the call list.
    ToolCallDelta {
        index: usize,
        id: Option<String>,
        name: Option<String>,
        arguments_delta: Option<String>,
    },
    /// The stream finished; carries the whole turn.
    Done { result: ChatCompletionResult },
}
