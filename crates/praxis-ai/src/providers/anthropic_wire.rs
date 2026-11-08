//! The Anthropic Messages API wire.
//!
//! Anthropic does not speak the OpenAI chat format: the system prompt is a
//! top-level field, tool calls are content blocks, and a tool result is a
//! user turn that quotes the call it answers.

use serde_json::{Value, json};

use super::reasoning_support::{ReasoningEffort, anthropic_thinking_config};
use super::wire::{
    ChatCompletionResult, ChatCompletionToolCall, ChatStreamEvent, GatewayToolDefinition,
    TokenUsage, WireMessage, WireRole, parse_tool_arguments,
};

/// What to ask Anthropic for.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnthropicRequestOptions {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub tools: Vec<GatewayToolDefinition>,
    /// How hard the model should think, for the models that support it.
    pub reasoning_effort: Option<ReasoningEffort>,
}

/// Builds the body of an Anthropic Messages request.
#[must_use]
pub fn anthropic_request_body(
    messages: &[WireMessage],
    model: &str,
    options: &AnthropicRequestOptions,
) -> Value {
    let system = messages
        .iter()
        .filter(|message| message.role == WireRole::System)
        .map(|message| message.content.clone().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n\n");
    let turns: Vec<Value> = messages
        .iter()
        .filter(|message| message.role != WireRole::System)
        .map(|message| {
            let role = if message.role == WireRole::Assistant {
                "assistant"
            } else {
                "user"
            };
            json!({ "role": role, "content": anthropic_content(message) })
        })
        .collect();

    let mut body = json!({
        "model": model,
        "max_tokens": options.max_tokens.unwrap_or(4096),
        "messages": turns,
    });
    let object = body.as_object_mut().expect("the body is an object");
    if !system.is_empty() {
        object.insert("system".to_string(), Value::String(system));
    }
    if let Some(temperature) = options.temperature {
        object.insert("temperature".to_string(), json!(temperature));
    }
    if !options.tools.is_empty() {
        let tools: Vec<Value> = options
            .tools
            .iter()
            .map(anthropic_tool_definition)
            .collect();
        object.insert("tools".to_string(), Value::Array(tools));
    }
    if let Some(thinking) = anthropic_thinking_config(Some(model), options.reasoning_effort) {
        if let Some(value) = thinking.thinking {
            object.insert("thinking".to_string(), value);
        }
        if let Some(value) = thinking.output_config {
            object.insert("output_config".to_string(), value);
        }
    }
    body
}

/// The content of one Anthropic turn: plain text, tool calls, or a tool result.
fn anthropic_content(message: &WireMessage) -> Value {
    if let Some(calls) = message
        .tool_calls
        .as_ref()
        .filter(|calls| !calls.is_empty())
    {
        let mut parts: Vec<Value> = Vec::new();
        if let Some(text) = message.content.clone().filter(|text| !text.is_empty()) {
            parts.push(json!({ "type": "text", "text": text }));
        }
        for call in calls {
            parts.push(json!({
                "type": "tool_use",
                "id": call.id,
                "name": call.function.name,
                "input": parse_tool_arguments(&call.function.arguments),
            }));
        }
        return Value::Array(parts);
    }
    if let Some(tool_call_id) = &message.tool_call_id {
        return json!([{
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": message.content.clone().unwrap_or_default(),
        }]);
    }
    Value::String(message.content.clone().unwrap_or_default())
}

/// Describes one tool the way Anthropic expects.
#[must_use]
pub fn anthropic_tool_definition(tool: &GatewayToolDefinition) -> Value {
    json!({
        "name": tool.name,
        "description": tool.description.clone().unwrap_or_default(),
        "input_schema": tool
            .input_schema
            .clone()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
    })
}

/// Reads an Anthropic Messages response.
#[must_use]
pub fn anthropic_response(payload: &Value) -> ChatCompletionResult {
    let blocks = payload
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    let thought = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("thinking"))
        .filter_map(|block| block.get("thinking").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    let tool_calls = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        .enumerate()
        .map(|(index, block)| ChatCompletionToolCall {
            id: block
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_{index}")),
            name: block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            arguments: block.get("input").cloned().unwrap_or_else(|| json!({})),
        })
        .collect();
    let reported = payload.get("usage");
    let usage = TokenUsage {
        input_tokens: reported
            .and_then(|usage| usage.get("input_tokens"))
            .and_then(Value::as_u64),
        output_tokens: reported
            .and_then(|usage| usage.get("output_tokens"))
            .and_then(Value::as_u64),
        total_tokens: None,
        reasoning_tokens: None,
        cached_input_tokens: reported
            .and_then(|usage| usage.get("cache_read_input_tokens"))
            .and_then(Value::as_u64),
    };
    ChatCompletionResult {
        text,
        thought,
        tool_calls,
        finish_reason: payload
            .get("stop_reason")
            .and_then(Value::as_str)
            .map(str::to_string),
        usage,
    }
}

/// Reads one event from an Anthropic stream.
#[must_use]
pub fn anthropic_stream_event(event_type: &str, data: &str) -> Option<ChatStreamEvent> {
    let payload: Value = serde_json::Value::from_str(data).ok()?;
    match event_type {
        "content_block_delta" => {
            let delta = payload.get("delta")?;
            for key in ["text", "thinking"] {
                if let Some(text) = delta
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    return Some(ChatStreamEvent::Text {
                        text: text.to_string(),
                    });
                }
            }
            None
        }
        "content_block_start" => {
            let block = payload.get("content_block")?;
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                return None;
            }
            Some(ChatStreamEvent::ToolCall {
                index: payload
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as usize,
                id: block.get("id").and_then(Value::as_str).map(str::to_string),
                name: block
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                args_delta: None,
            })
        }
        "message_delta" => Some(ChatStreamEvent::Usage {
            usage: TokenUsage {
                output_tokens: payload
                    .get("usage")
                    .and_then(|usage| usage.get("output_tokens"))
                    .and_then(Value::as_u64),
                ..TokenUsage::default()
            },
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        AnthropicRequestOptions, anthropic_request_body, anthropic_response,
        anthropic_stream_event, anthropic_tool_definition,
    };
    use crate::providers::reasoning_support::ReasoningEffort;
    use crate::providers::wire::{
        GatewayToolDefinition, OpenAiToolCall, OpenAiToolCallFunction, WireMessage, WireRole,
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
    fn puts_the_system_prompt_on_top_of_the_request() {
        let body = anthropic_request_body(
            &[
                message(WireRole::System, "Be brief."),
                message(WireRole::User, "Hello"),
            ],
            "claude-opus-4-5",
            &AnthropicRequestOptions::default(),
        );

        assert_eq!(body["system"], "Be brief.");
        assert_eq!(body["model"], "claude-opus-4-5");
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["messages"].as_array().map(Vec::len), Some(1));
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "Hello");
    }

    #[test]
    fn turns_tool_calls_into_tool_use_blocks() {
        let mut assistant = message(WireRole::Assistant, "");
        assistant.tool_calls = Some(vec![OpenAiToolCall {
            id: "call_1".to_string(),
            kind: "function".to_string(),
            function: OpenAiToolCallFunction {
                name: "read_file".to_string(),
                arguments: "{\"path\":\"a.txt\"}".to_string(),
            },
        }]);

        let body = anthropic_request_body(
            &[assistant],
            "claude-opus-4-5",
            &AnthropicRequestOptions::default(),
        );

        let blocks = body["messages"][0]["content"]
            .as_array()
            .expect("content blocks");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "tool_use");
        assert_eq!(blocks[0]["id"], "call_1");
        assert_eq!(blocks[0]["name"], "read_file");
        assert_eq!(blocks[0]["input"]["path"], "a.txt");
    }

    #[test]
    fn turns_a_tool_result_into_a_tool_result_block() {
        let mut result = message(WireRole::Tool, "file contents");
        result.tool_call_id = Some("call_1".to_string());

        let body = anthropic_request_body(
            &[result],
            "claude-opus-4-5",
            &AnthropicRequestOptions::default(),
        );

        let blocks = body["messages"][0]["content"]
            .as_array()
            .expect("content blocks");
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(blocks[0]["tool_use_id"], "call_1");
        assert_eq!(blocks[0]["content"], "file contents");
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[test]
    fn describes_a_tool_with_its_input_schema() {
        let tool = GatewayToolDefinition {
            name: "read_file".to_string(),
            description: Some("Reads a file.".to_string()),
            input_schema: Some(
                json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
            ),
        };

        let definition = anthropic_tool_definition(&tool);

        assert_eq!(definition["name"], "read_file");
        assert_eq!(definition["description"], "Reads a file.");
        assert_eq!(definition["input_schema"]["type"], "object");
    }

    #[test]
    fn gives_a_tool_without_a_schema_an_empty_one() {
        let tool = GatewayToolDefinition {
            name: "read_file".to_string(),
            description: None,
            input_schema: None,
        };

        let definition = anthropic_tool_definition(&tool);

        assert_eq!(definition["description"], "");
        assert_eq!(definition["input_schema"]["type"], "object");
    }

    #[test]
    fn asks_a_reasoning_model_to_think() {
        let body = anthropic_request_body(
            &[message(WireRole::User, "Hello")],
            "claude-opus-4-5",
            &AnthropicRequestOptions {
                reasoning_effort: Some(ReasoningEffort::Low),
                ..AnthropicRequestOptions::default()
            },
        );

        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 1024);
    }

    #[test]
    fn asks_an_adaptive_model_to_use_the_adaptive_mode() {
        let body = anthropic_request_body(
            &[message(WireRole::User, "Hello")],
            "claude-fable-5.1",
            &AnthropicRequestOptions {
                reasoning_effort: Some(ReasoningEffort::Low),
                ..AnthropicRequestOptions::default()
            },
        );

        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["output_config"]["effort"], "low");
    }

    #[test]
    fn reads_the_text_the_thinking_the_tool_calls_and_the_usage() {
        let payload = json!({
            "content": [
                { "type": "thinking", "thinking": "Let me think." },
                { "type": "text", "text": "Hello" },
                { "type": "tool_use", "id": "toolu_1", "name": "read_file", "input": { "path": "a.txt" } }
            ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 20, "output_tokens": 8, "cache_read_input_tokens": 5 }
        });

        let result = anthropic_response(&payload);

        assert_eq!(result.text, "Hello");
        assert_eq!(result.thought, "Let me think.");
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].id, "toolu_1");
        assert_eq!(
            result.tool_calls[0].arguments["path"].as_str(),
            Some("a.txt")
        );
        assert_eq!(result.finish_reason.as_deref(), Some("tool_use"));
        assert_eq!(result.usage.input_tokens, Some(20));
        assert_eq!(result.usage.output_tokens, Some(8));
        assert_eq!(result.usage.cached_input_tokens, Some(5));
    }

    #[test]
    fn reads_a_response_that_has_no_content() {
        let result = anthropic_response(&json!({}));

        assert_eq!(result.text, "");
        assert!(result.tool_calls.is_empty());
    }

    #[test]
    fn reads_a_text_delta() {
        let event =
            anthropic_stream_event("content_block_delta", "{\"delta\":{\"text\":\"Hello\"}}")
                .expect("a text delta");

        assert!(matches!(event, super::ChatStreamEvent::Text { .. }));
    }

    #[test]
    fn reads_a_thinking_delta_as_text() {
        let event =
            anthropic_stream_event("content_block_delta", "{\"delta\":{\"thinking\":\"Hmm\"}}")
                .expect("a thinking delta");

        assert!(matches!(event, super::ChatStreamEvent::Text { .. }));
    }

    #[test]
    fn reads_a_tool_call_start() {
        let event = anthropic_stream_event(
            "content_block_start",
            "{\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_file\"}}",
        )
        .expect("a tool call start");

        match event {
            super::ChatStreamEvent::ToolCall {
                index, id, name, ..
            } => {
                assert_eq!(index, 2);
                assert_eq!(id.as_deref(), Some("toolu_1"));
                assert_eq!(name.as_deref(), Some("read_file"));
            }
            other => panic!("expected a tool call, got {other:?}"),
        }
    }

    #[test]
    fn reads_the_usage_a_message_delta_reports() {
        let event = anthropic_stream_event("message_delta", "{\"usage\":{\"output_tokens\":42}}")
            .expect("a usage event");

        match event {
            super::ChatStreamEvent::Usage { usage } => {
                assert_eq!(usage.output_tokens, Some(42));
            }
            other => panic!("expected usage, got {other:?}"),
        }
    }

    #[test]
    fn ignores_an_event_it_does_not_know() {
        assert!(anthropic_stream_event("message_start", "{}").is_none());
        assert!(anthropic_stream_event("content_block_delta", "not json").is_none());
    }
}
