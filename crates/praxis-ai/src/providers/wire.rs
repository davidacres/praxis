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

/// Everything one chat completion produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionResult {
    pub text: String,
    /// The model's visible reasoning, when the provider returns any.
    #[serde(default)]
    pub thought: String,
    pub tool_calls: Vec<ChatCompletionToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub usage: TokenUsage,
}

/// One piece of a streamed chat completion.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatStreamEvent {
    /// A piece of the answer, or of the model's reasoning.
    Text { text: String },
    /// A tool call the model started making.
    ToolCall {
        index: usize,
        id: Option<String>,
        name: Option<String>,
        args_delta: Option<String>,
    },
    /// What the provider reported it has used so far.
    Usage { usage: TokenUsage },
    /// The completion, once the stream has ended.
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

/// One message as OpenAI sends it. A message carrying images gets the multipart `content` array,
/// the text part first and then one `image_url` data-URL part per attachment; any other message
/// passes through unchanged.
fn openai_message(message: &WireMessage) -> serde_json::Value {
    let mut value = serde_json::to_value(message).unwrap_or(serde_json::Value::Null);
    let images = message.images.as_deref().unwrap_or_default();
    if images.is_empty() {
        return value;
    }
    let mut parts: Vec<serde_json::Value> = Vec::new();
    if let Some(text) = message.content.as_deref().filter(|text| !text.is_empty()) {
        parts.push(serde_json::json!({ "type": "text", "text": text }));
    }
    for image in images {
        parts.push(serde_json::json!({ "type": "image_url", "image_url": { "url": format!("data:{};base64,{}", image.mime_type, image.data_base64) } }));
    }
    if let Some(object) = value.as_object_mut() {
        object.remove("images");
        object.insert("content".to_string(), serde_json::Value::Array(parts));
    }
    value
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
    body.insert("messages".to_string(), serde_json::Value::Array(messages.iter().map(openai_message).collect()));
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
            if message
                .tool_calls
                .as_ref()
                .is_some_and(|calls| !calls.is_empty())
            {
                return true;
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

/// Parses the arguments a model wrote for a tool call.
///
/// A model that wrote malformed JSON still asked for the tool, so the raw
/// text is kept rather than dropped.
#[must_use]
pub fn parse_tool_arguments(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw)
        .unwrap_or_else(|_| serde_json::json!({ "type": "object", "raw": raw }))
}

/// Reads a whole, non-streamed chat completion.
#[must_use]
pub fn collect_chat_completion(payload: &serde_json::Value) -> ChatCompletionResult {
    let choice = payload
        .get("choices")
        .and_then(serde_json::Value::as_array)
        .and_then(|choices| choices.first());
    let message = choice
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let tool_calls = message
        .get("tool_calls")
        .and_then(serde_json::Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .enumerate()
                .map(|(index, call)| ChatCompletionToolCall {
                    id: call
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("call_{index}")),
                    name: call
                        .get("function")
                        .and_then(|function| function.get("name"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    arguments: parse_tool_arguments(
                        call.get("function")
                            .and_then(|function| function.get("arguments"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default(),
                    ),
                })
                .collect()
        })
        .unwrap_or_default();
    let reported = payload.get("usage");
    let usage = TokenUsage {
        input_tokens: reported
            .and_then(|usage| usage.get("prompt_tokens"))
            .and_then(serde_json::Value::as_u64),
        output_tokens: reported
            .and_then(|usage| usage.get("completion_tokens"))
            .and_then(serde_json::Value::as_u64),
        total_tokens: reported
            .and_then(|usage| usage.get("total_tokens"))
            .and_then(serde_json::Value::as_u64),
        reasoning_tokens: reported
            .and_then(|usage| usage.get("completion_tokens_details"))
            .and_then(|details| details.get("reasoning_tokens"))
            .and_then(serde_json::Value::as_u64),
        cached_input_tokens: reported
            .and_then(|usage| usage.get("prompt_tokens_details"))
            .and_then(|details| details.get("cached_tokens"))
            .and_then(serde_json::Value::as_u64),
    };
    ChatCompletionResult {
        text: message
            .get("content")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        thought: String::new(),
        tool_calls,
        finish_reason: choice
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        usage,
    }
}

/// One event read from a server-sent event stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// The event type, from an `event:` line if present.
    pub event: Option<String>,
    /// The event payload, from the `data:` lines.
    pub data: String,
}

/// A stream of server-sent events.
#[async_trait::async_trait]
pub trait EventStream: Send {
    /// Yields the next event, or `None` when the stream ends.
    async fn next_event(&mut self) -> Option<Result<SseEvent, String>>;
}

/// A provider response body, arriving in pieces.
#[async_trait::async_trait]
pub trait ByteStream: Send {
    /// The next piece of the body, or `None` once it has ended.
    async fn next_chunk(&mut self) -> Option<Result<Vec<u8>, String>>;
}

/// Pulls the `data:` payloads out of a server-sent event stream.
#[derive(Debug, Default)]
pub struct SseReader {
    buffer: String,
}

impl SseReader {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a chunk of the body in, returning the payloads it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        let mut payloads = Vec::new();
        while let Some(newline) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=newline).collect();
            let line = line.trim();
            if !line.starts_with("data:") {
                continue;
            }
            payloads.push(line[5..].trim().to_string());
        }
        payloads
    }
}

/// A tool call as it is being streamed, before its arguments are complete.
#[derive(Debug, Default, Clone)]
struct ToolCallDraft {
    id: Option<String>,
    name: Option<String>,
    args: String,
}

/// Reads a streamed chat completion, reporting each piece as it arrives.
pub async fn consume_chat_stream(
    stream: &mut dyn EventStream,
    mut on_event: impl FnMut(ChatStreamEvent),
) -> Result<ChatCompletionResult, String> {
    let mut text = String::new();
    let mut thought = String::new();
    let mut tool_calls: Vec<ToolCallDraft> = Vec::new();
    let mut usage = TokenUsage::default();
    let mut finish_reason: Option<String> = None;

    'stream: while let Some(event) = stream.next_event().await {
        let event = event?;
        let data = event.data;
        if data == "[DONE]" {
            break 'stream;
        }
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        let choice = payload
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .and_then(|choices| choices.first());
        let delta = choice
            .and_then(|choice| choice.get("delta"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        if let Some(content) = delta.get("content").and_then(serde_json::Value::as_str) {
            if !content.is_empty() {
                text.push_str(content);
                on_event(ChatStreamEvent::Text {
                    text: content.to_string(),
                });
            }
        }
        for key in ["reasoning_content", "reasoning"] {
            if let Some(reasoning) = delta.get(key).and_then(serde_json::Value::as_str) {
                if !reasoning.is_empty() {
                    thought.push_str(reasoning);
                }
            }
        }
        if let Some(calls) = delta
            .get("tool_calls")
            .and_then(serde_json::Value::as_array)
        {
            for call in calls {
                let index = call
                    .get("index")
                    .and_then(serde_json::Value::as_u64)
                    .map(|index| index as usize)
                    .unwrap_or(tool_calls.len());
                let id = call
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                let name = call
                    .get("function")
                    .and_then(|function| function.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                let args_delta = call
                    .get("function")
                    .and_then(|function| function.get("arguments"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                while tool_calls.len() <= index {
                    tool_calls.push(ToolCallDraft::default());
                }
                let entry = &mut tool_calls[index];
                if let Some(id) = &id {
                    entry.id = Some(id.clone());
                }
                if let Some(name) = &name {
                    entry.name = Some(name.clone());
                }
                if let Some(args) = &args_delta {
                    entry.args.push_str(args);
                }
                on_event(ChatStreamEvent::ToolCall {
                    index,
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                    args_delta,
                });
            }
        }
        if let Some(reason) = choice
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(serde_json::Value::as_str)
        {
            finish_reason = Some(reason.to_string());
        }
        if let Some(reported) = payload.get("usage").filter(|usage| !usage.is_null()) {
            usage = TokenUsage {
                input_tokens: reported
                    .get("prompt_tokens")
                    .and_then(serde_json::Value::as_u64)
                    .or(usage.input_tokens),
                output_tokens: reported
                    .get("completion_tokens")
                    .and_then(serde_json::Value::as_u64)
                    .or(usage.output_tokens),
                total_tokens: reported
                    .get("total_tokens")
                    .and_then(serde_json::Value::as_u64)
                    .or(usage.total_tokens),
                reasoning_tokens: reported
                    .get("completion_tokens_details")
                    .and_then(|details| details.get("reasoning_tokens"))
                    .and_then(serde_json::Value::as_u64)
                    .or(usage.reasoning_tokens),
                cached_input_tokens: reported
                    .get("prompt_tokens_details")
                    .and_then(|details| details.get("cached_tokens"))
                    .and_then(serde_json::Value::as_u64)
                    .or(usage.cached_input_tokens),
            };
            on_event(ChatStreamEvent::Usage { usage });
        }
    }

    let calls = tool_calls
        .iter()
        .filter(|call| call.id.is_some() || call.name.is_some())
        .enumerate()
        .map(|(index, call)| ChatCompletionToolCall {
            id: call.id.clone().unwrap_or_else(|| format!("call_{index}")),
            name: call.name.clone().unwrap_or_default(),
            arguments: parse_tool_arguments(&call.args),
        })
        .collect();
    let result = ChatCompletionResult {
        text,
        thought,
        tool_calls: calls,
        finish_reason,
        usage,
    };
    on_event(ChatStreamEvent::Done {
        result: result.clone(),
    });
    Ok(result)
}

#[cfg(test)]
mod stream_tests {
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use futures_core::Stream;

    use super::{
        ChatCompletionResult, ChatStreamEvent, EventStream, SseEvent, collect_chat_completion,
        consume_chat_stream, parse_tool_arguments,
    };

    /// A response that hands over fixed events.
    struct FakeStream {
        events: Vec<Result<SseEvent, String>>,
        index: usize,
    }

    impl FakeStream {
        fn new(events: Vec<SseEvent>) -> Self {
            Self {
                events: events.into_iter().map(Ok).collect(),
                index: 0,
            }
        }
    }

    #[async_trait::async_trait]
    impl EventStream for FakeStream {
        async fn next_event(&mut self) -> Option<Result<SseEvent, String>> {
            let event = self.events.get(self.index)?.clone();
            self.index += 1;
            Some(event)
        }
    }

    /// A body that hands over fixed pieces of bytes.
    struct FakeBody {
        chunks: Vec<bytes::Bytes>,
        index: usize,
    }

    impl Stream for FakeBody {
        type Item = Result<bytes::Bytes, std::io::Error>;

        fn poll_next(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            let this = self.get_mut();
            if this.index >= this.chunks.len() {
                return Poll::Ready(None);
            }
            let chunk = this.chunks[this.index].clone();
            this.index += 1;
            Poll::Ready(Some(Ok(chunk)))
        }
    }

    fn event(payload: serde_json::Value) -> SseEvent {
        SseEvent {
            event: None,
            data: payload.to_string(),
        }
    }

    fn done() -> SseEvent {
        SseEvent {
            event: None,
            data: "[DONE]".to_string(),
        }
    }

    #[tokio::test]
    async fn reads_text_deltas_into_the_answer() {
        let mut stream = FakeStream::new(vec![
            event(serde_json::json!({ "choices": [{ "delta": { "content": "Hello" } }] })),
            event(serde_json::json!({ "choices": [{ "delta": { "content": " there" } }] })),
            done(),
        ]);
        let mut events: Vec<ChatStreamEvent> = Vec::new();
        let result = consume_chat_stream(&mut stream, |event| events.push(event))
            .await
            .expect("the stream completes");

        assert_eq!(result.text, "Hello there");
        assert!(matches!(events[0], ChatStreamEvent::Text { .. }));
        assert!(matches!(events.last(), Some(ChatStreamEvent::Done { .. })));
    }

    #[tokio::test]
    async fn stops_reading_at_the_done_marker() {
        let mut stream = FakeStream::new(vec![
            done(),
            event(serde_json::json!({ "choices": [{ "delta": { "content": "ignored" } }] })),
        ]);
        let result = consume_chat_stream(&mut stream, |_| {})
            .await
            .expect("the stream completes");

        assert_eq!(result.text, "");
    }

    #[tokio::test]
    async fn assembles_a_tool_call_from_its_deltas() {
        let mut stream = FakeStream::new(vec![
            event(serde_json::json!({
                "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_1", "function": { "name": "read_file", "arguments": "{\"path\":" } }] } }]
            })),
            event(serde_json::json!({
                "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "\"a.txt\"}" } }] } }]
            })),
        ]);
        let result = consume_chat_stream(&mut stream, |_| {})
            .await
            .expect("the stream completes");

        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].id, "call_1");
        assert_eq!(result.tool_calls[0].name, "read_file");
        assert_eq!(
            result.tool_calls[0].arguments["path"].as_str(),
            Some("a.txt")
        );
    }

    #[tokio::test]
    async fn reports_the_usage_the_provider_sends() {
        let mut stream = FakeStream::new(vec![event(serde_json::json!({
            "choices": [{ "delta": {}, "finish_reason": "stop" }],
            "usage": {
                "prompt_tokens": 120,
                "completion_tokens": 30,
                "total_tokens": 150,
                "completion_tokens_details": { "reasoning_tokens": 12 },
                "prompt_tokens_details": { "cached_tokens": 60 }
            }
        }))]);
        let result = consume_chat_stream(&mut stream, |_| {})
            .await
            .expect("the stream completes");

        assert_eq!(result.usage.input_tokens, Some(120));
        assert_eq!(result.usage.output_tokens, Some(30));
        assert_eq!(result.usage.total_tokens, Some(150));
        assert_eq!(result.usage.reasoning_tokens, Some(12));
        assert_eq!(result.usage.cached_input_tokens, Some(60));
        assert_eq!(result.finish_reason.as_deref(), Some("stop"));
    }

    #[tokio::test]
    async fn skips_a_payload_that_is_not_json() {
        let mut stream = FakeStream::new(vec![
            SseEvent {
                event: None,
                data: "not json".to_string(),
            },
            event(serde_json::json!({ "choices": [{ "delta": { "content": "ok" } }] })),
        ]);
        let result = consume_chat_stream(&mut stream, |_| {})
            .await
            .expect("the stream completes");

        assert_eq!(result.text, "ok");
    }

    #[tokio::test]
    async fn reads_a_payload_that_lands_across_two_chunks() {
        use eventsource_stream::Eventsource;

        let body: Pin<Box<dyn Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send>> =
            Box::pin(FakeBody {
                chunks: vec![
                    bytes::Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"con"),
                    bytes::Bytes::from_static(b"tent\":\"split\"}}]}\n\n"),
                ],
                index: 0,
            });
        let mut source = Box::pin(body.eventsource());

        let first = std::future::poll_fn(|context| source.as_mut().poll_next(context)).await;

        let event = first.expect("an event").expect("a well-formed event");
        assert_eq!(
            event.data,
            "{\"choices\":[{\"delta\":{\"content\":\"split\"}}]}"
        );
    }

    #[tokio::test]
    async fn keeps_the_event_type_the_stream_named() {
        use eventsource_stream::Eventsource;

        let body: Pin<Box<dyn Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send>> =
            Box::pin(FakeBody {
                chunks: vec![bytes::Bytes::from_static(
                    b"event: content_block_delta\ndata: {\"delta\":{\"text\":\"Hi\"}}\n\n",
                )],
                index: 0,
            });
        let mut source = Box::pin(body.eventsource());

        let event = std::future::poll_fn(|context| source.as_mut().poll_next(context))
            .await
            .expect("an event")
            .expect("a well-formed event");

        assert_eq!(event.event.as_str(), "content_block_delta");
        assert_eq!(event.data, "{\"delta\":{\"text\":\"Hi\"}}");
    }

    #[test]
    fn keeps_malformed_tool_arguments_as_written() {
        let arguments = parse_tool_arguments("{not json");

        assert_eq!(arguments["type"].as_str(), Some("object"));
        assert_eq!(arguments["raw"].as_str(), Some("{not json"));
    }

    #[test]
    fn reads_a_whole_completion() {
        let payload = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "Hello",
                    "tool_calls": [{ "id": "call_1", "function": { "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" } }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 }
        });

        let result: ChatCompletionResult = collect_chat_completion(&payload);

        assert_eq!(result.text, "Hello");
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(
            result.tool_calls[0].arguments["path"].as_str(),
            Some("a.txt")
        );
        assert_eq!(result.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(result.usage.input_tokens, Some(10));
    }

    #[test]
    fn gives_an_unnamed_tool_call_a_generated_id() {
        let payload = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [{ "function": { "name": "read_file", "arguments": "{}" } }] } }]
        });

        let result = collect_chat_completion(&payload);

        assert_eq!(result.tool_calls[0].id, "call_0");
    }
}
