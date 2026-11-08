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
    /// The turn's text. `None` serialises as `null`, which is what an
    /// assistant turn that only calls tools has to send.
    #[serde(default)]
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

/// The path a chat-completion request is sent to.
pub const CHAT_COMPLETIONS_PATH: &str = "/v1/chat/completions";

/// What to ask a provider for.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatRequestOptions {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub tools: Vec<GatewayToolDefinition>,
    pub tool_choice: Option<String>,
    /// Ask for a streamed answer rather than a whole one.
    pub stream: bool,
    /// Extra fields merged into the request body.
    pub extra_body: serde_json::Map<String, serde_json::Value>,
}

/// A chat-completion request, ready to send.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatRequest {
    pub url: String,
    pub method: String,
    /// The headers to send, as name/value pairs.
    pub headers: Vec<(String, String)>,
    pub body: serde_json::Value,
}

/// Builds a chat-completion request.
///
/// The body is the OpenAI-compatible shape every Praxis provider accepts, so
/// one builder serves the built-in providers and the user's own endpoint.
#[must_use]
pub fn build_chat_request(
    messages: &[WireMessage],
    model: &str,
    options: &ChatRequestOptions,
) -> ChatRequest {
    let mut body = serde_json::Map::new();
    body.insert(
        "model".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    body.insert(
        "messages".to_string(),
        serde_json::to_value(messages).unwrap_or(serde_json::Value::Null),
    );
    if let Some(temperature) = options.temperature {
        body.insert("temperature".to_string(), serde_json::json!(temperature));
    }
    if let Some(max_tokens) = options.max_tokens {
        body.insert("max_tokens".to_string(), serde_json::json!(max_tokens));
    }
    if !options.tools.is_empty() {
        let tools: Vec<serde_json::Value> = options
            .tools
            .iter()
            .map(|tool| {
                let mut function = serde_json::Map::new();
                function.insert("name".to_string(), serde_json::json!(tool.name));
                if let Some(description) = &tool.description {
                    function.insert("description".to_string(), serde_json::json!(description));
                }
                function.insert(
                    "parameters".to_string(),
                    tool.input_schema.clone().unwrap_or_else(
                        || serde_json::json!({ "type": "object", "properties": {} }),
                    ),
                );
                serde_json::json!({ "type": "function", "function": function })
            })
            .collect();
        body.insert("tools".to_string(), serde_json::Value::Array(tools));
    }
    if let Some(tool_choice) = &options.tool_choice {
        body.insert("tool_choice".to_string(), serde_json::json!(tool_choice));
    }
    for (key, value) in &options.extra_body {
        body.insert(key.clone(), value.clone());
    }
    if options.stream {
        body.insert("stream".to_string(), serde_json::json!(true));
        // Without this, a streamed answer reports no tokens at all.
        body.insert(
            "stream_options".to_string(),
            serde_json::json!({ "include_usage": true }),
        );
    }
    ChatRequest {
        url: CHAT_COMPLETIONS_PATH.to_string(),
        method: "POST".to_string(),
        headers: vec![("Content-Type".to_string(), "application/json".to_string())],
        body: serde_json::Value::Object(body),
    }
}

/// An assistant turn that calls tools.
#[must_use]
pub fn assistant_message_with_tool_calls(text: &str, tool_calls: &[OpenAiToolCall]) -> WireMessage {
    WireMessage {
        role: WireRole::Assistant,
        content: if text.is_empty() {
            None
        } else {
            Some(text.to_string())
        },
        tool_calls: Some(tool_calls.to_vec()),
        tool_call_id: None,
        images: None,
    }
}

/// The result of one tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResult {
    /// The call this answers. Falls back to the call at the same position.
    pub call_id: Option<String>,
    pub content: String,
}

/// The tool turns that answer a batch of tool calls.
#[must_use]
pub fn tool_result_messages(
    tool_calls: &[OpenAiToolCall],
    results: &[ToolResult],
) -> Vec<WireMessage> {
    results
        .iter()
        .enumerate()
        .map(|(index, result)| WireMessage {
            role: WireRole::Tool,
            content: Some(result.content.clone()),
            tool_calls: None,
            tool_call_id: Some(
                result
                    .call_id
                    .clone()
                    .or_else(|| tool_calls.get(index).map(|call| call.id.clone()))
                    .unwrap_or_default(),
            ),
            images: None,
        })
        .collect()
}

/// Trims a tool's output so it fits the budget the caller has.
///
/// The cut is marked with an ellipsis, so a truncated result is not mistaken
/// for a complete one.
#[must_use]
pub fn trim_tool_output_to_budget(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    if max_chars == 0 {
        return String::new();
    }
    let mut trimmed: String = text.chars().take(max_chars - 1).collect();
    trimmed.push('…');
    trimmed
}

/// Prepares a history to be replayed to a provider.
///
/// Two kinds of turn are dropped:
///
/// - A tool turn whose call is not in the history, which a provider would
///   reject as an answer to a question it was never asked.
/// - An assistant turn that is really a note to the model — the system
///   preamble a previous run wrote into the transcript — because replaying it
///   would have the model answer instructions that were never part of the
///   conversation.
#[must_use]
pub fn compact_history_for_replay(history: &[WireMessage]) -> Vec<WireMessage> {
    let mut tool_call_ids: Vec<String> = Vec::new();
    for message in history {
        for call in message.tool_calls.iter().flatten() {
            tool_call_ids.push(call.id.clone());
        }
    }

    history
        .iter()
        .filter(|message| {
            if message.role == WireRole::Tool {
                let call_id = message.tool_call_id.as_deref().unwrap_or_default();
                return tool_call_ids.iter().any(|id| id == call_id);
            }
            let Some(content) = message.content.as_deref() else {
                return false;
            };
            if content.is_empty() {
                return false;
            }
            if message.role != WireRole::Assistant {
                return true;
            }
            if message
                .tool_calls
                .as_ref()
                .is_some_and(|calls| !calls.is_empty())
            {
                return true;
            }
            !is_transcript_note(content)
        })
        .cloned()
        .collect()
}

/// Whether a turn is a note to the model rather than part of the conversation.
fn is_transcript_note(content: &str) -> bool {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(?:^|\n)\s*(?:\[System\]|System:|\[User\]|\[Assistant\]|You have|Your task)",
        )
        .expect("the transcript note pattern is valid")
    });
    pattern.is_match(content)
}

/// Cleans up a tool-call id so it is safe to use in a provider request.
///
/// A provider's id can carry anything, and some of them reject the
/// characters a request body allows.
#[must_use]
pub fn sanitize_tool_call_id(id: &str) -> String {
    id.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        ChatRequestOptions, GatewayToolDefinition, OpenAiToolCall, ToolResult, WireMessage,
        WireRole, assistant_message_with_tool_calls, build_chat_request,
        compact_history_for_replay, sanitize_tool_call_id, tool_result_messages,
        trim_tool_output_to_budget,
    };

    fn message(role: WireRole, content: &str) -> WireMessage {
        WireMessage {
            role,
            content: Some(content.to_string()),
            tool_calls: None,
            tool_call_id: None,
            images: None,
        }
    }

    #[test]
    fn a_chat_request_is_built_in_the_openai_compatible_shape() {
        let request = build_chat_request(
            &[message(WireRole::User, "hi")],
            "gpt-4o",
            &ChatRequestOptions::default(),
        );
        assert_eq!(request.url, "/v1/chat/completions");
        assert_eq!(request.method, "POST");
        assert_eq!(
            request
                .headers
                .iter()
                .find(|(name, _)| name == "Content-Type")
                .map(|(_, value)| value.as_str()),
            Some("application/json")
        );
        assert_eq!(request.body["model"], serde_json::json!("gpt-4o"));
        assert_eq!(
            request.body["messages"][0]["role"],
            serde_json::json!("user")
        );
        assert_eq!(
            request.body["messages"][0]["content"],
            serde_json::json!("hi")
        );
    }

    #[test]
    fn the_optional_fields_are_only_sent_when_they_were_asked_for() {
        let request = build_chat_request(&[], "gpt-4o", &ChatRequestOptions::default());
        assert!(request.body.get("temperature").is_none());
        assert!(request.body.get("max_tokens").is_none());
        assert!(request.body.get("tools").is_none());
        assert!(request.body.get("tool_choice").is_none());
        assert!(request.body.get("stream").is_none());

        let options = ChatRequestOptions {
            temperature: Some(0.2),
            max_tokens: Some(512),
            tools: vec![GatewayToolDefinition {
                name: "read_file".to_string(),
                description: Some("Read a file".to_string()),
                input_schema: None,
            }],
            tool_choice: Some("auto".to_string()),
            stream: false,
            extra_body: serde_json::Map::new(),
        };
        let request = build_chat_request(&[], "gpt-4o", &options);
        assert_eq!(request.body["temperature"], serde_json::json!(0.2));
        assert_eq!(request.body["max_tokens"], serde_json::json!(512));
        assert_eq!(
            request.body["tools"][0]["function"]["name"],
            serde_json::json!("read_file")
        );
        assert_eq!(
            request.body["tools"][0]["function"]["description"],
            serde_json::json!("Read a file")
        );
        assert_eq!(
            request.body["tools"][0]["function"]["parameters"],
            serde_json::json!({ "type": "object", "properties": {} })
        );
        assert_eq!(request.body["tool_choice"], serde_json::json!("auto"));
    }

    #[test]
    fn a_streamed_request_asks_for_the_usage_too() {
        let options = ChatRequestOptions {
            stream: true,
            ..ChatRequestOptions::default()
        };
        let request = build_chat_request(&[], "gpt-4o", &options);
        assert_eq!(request.body["stream"], serde_json::json!(true));
        assert_eq!(
            request.body["stream_options"],
            serde_json::json!({ "include_usage": true })
        );
    }

    #[test]
    fn an_assistant_turn_that_calls_tools_carries_the_calls() {
        let call = OpenAiToolCall::function("call-1", "read_file", "{}");
        let message = assistant_message_with_tool_calls("", std::slice::from_ref(&call));
        assert_eq!(message.role, WireRole::Assistant);
        assert_eq!(message.content, None);
        assert_eq!(message.tool_calls.as_ref().map(Vec::len), Some(1));
    }

    #[test]
    fn tool_result_turns_answer_each_call() {
        let calls = vec![
            OpenAiToolCall::function("call-1", "read_file", "{}"),
            OpenAiToolCall::function("call-2", "list_dir", "{}"),
        ];
        let results = vec![
            ToolResult {
                call_id: None,
                content: "contents".to_string(),
            },
            ToolResult {
                call_id: None,
                content: "entries".to_string(),
            },
        ];
        let messages = tool_result_messages(&calls, &results);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, WireRole::Tool);
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(messages[0].content.as_deref(), Some("contents"));
        assert_eq!(messages[1].tool_call_id.as_deref(), Some("call-2"));
    }

    #[test]
    fn a_tool_output_that_is_too_long_is_trimmed_and_marked() {
        let trimmed = trim_tool_output_to_budget("abcdef", 4);
        assert_eq!(trimmed, "abc…");
        assert_eq!(trimmed.chars().count(), 4);
    }

    #[test]
    fn a_tool_output_that_fits_is_kept_whole() {
        assert_eq!(trim_tool_output_to_budget("abc", 4), "abc");
        assert_eq!(trim_tool_output_to_budget("abcd", 4), "abcd");
    }

    #[test]
    fn a_tool_turn_without_a_matching_call_is_dropped() {
        let call = OpenAiToolCall::function("call-1", "read_file", "{}");
        let history = vec![
            message(WireRole::User, "hello"),
            WireMessage {
                role: WireRole::Tool,
                content: Some("stray".to_string()),
                tool_calls: None,
                tool_call_id: Some("call-missing".to_string()),
                images: None,
            },
            assistant_message_with_tool_calls("", std::slice::from_ref(&call)),
        ];
        let replayed = compact_history_for_replay(&history);
        assert_eq!(replayed.len(), 2);
        assert_eq!(replayed[0].role, WireRole::User);
        assert_eq!(replayed[1].tool_calls.as_ref().map(Vec::len), Some(1));
    }

    #[test]
    fn a_note_written_into_the_transcript_is_dropped_from_a_replay() {
        let history = vec![
            message(WireRole::User, "hello"),
            message(WireRole::Assistant, "[System] You are a helpful assistant."),
            message(WireRole::Assistant, "Here is the answer."),
        ];
        let replayed = compact_history_for_replay(&history);
        assert_eq!(replayed.len(), 2);
        assert_eq!(replayed[1].content.as_deref(), Some("Here is the answer."));
    }

    #[test]
    fn a_tool_call_id_is_made_safe_for_a_request_body() {
        assert_eq!(sanitize_tool_call_id("call_1"), "call_1");
        assert_eq!(sanitize_tool_call_id("call id!"), "call-id-");
        assert_eq!(sanitize_tool_call_id("a/b"), "a-b");
    }
}
