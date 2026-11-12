//! The Gemini generateContent wire.
//!
//! Gemini calls the assistant turn `model`, carries the system prompt in
//! `systemInstruction`, and describes tools as function declarations.

use serde_json::{Value, json};

use super::wire::{
    ChatCompletionResult, ChatCompletionToolCall, ChatStreamEvent, GatewayToolDefinition,
    TokenUsage, WireMessage, WireRole, parse_tool_arguments,
};

/// What to ask Gemini for.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GeminiRequestOptions {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub tools: Vec<GatewayToolDefinition>,
}

/// Builds the body of a Gemini generateContent request.
///
/// The model travels in the URL rather than the body, so it is not repeated here.
#[must_use]
pub fn gemini_request_body(messages: &[WireMessage], options: &GeminiRequestOptions) -> Value {
    let system = messages
        .iter()
        .filter(|message| message.role == WireRole::System)
        .map(|message| message.content.clone().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n\n");
    let contents: Vec<Value> = messages
        .iter()
        .filter(|message| message.role != WireRole::System)
        .map(|message| {
            let role = if message.role == WireRole::Assistant {
                "model"
            } else {
                "user"
            };
            json!({ "role": role, "parts": gemini_parts(message) })
        })
        .collect();

    let mut body = json!({ "contents": contents });
    let object = body.as_object_mut().expect("the body is an object");
    if !system.is_empty() {
        object.insert(
            "systemInstruction".to_string(),
            json!({ "role": "user", "parts": [{ "text": system }] }),
        );
    }
    let mut generation: Vec<(&str, Value)> = Vec::new();
    if let Some(temperature) = options.temperature {
        generation.push(("temperature", json!(temperature)));
    }
    if let Some(max_tokens) = options.max_tokens {
        generation.push(("maxOutputTokens", json!(max_tokens)));
    }
    if !generation.is_empty() {
        let mut config = serde_json::Map::new();
        for (key, value) in generation {
            config.insert(key.to_string(), value);
        }
        object.insert("generationConfig".to_string(), Value::Object(config));
    }
    if !options.tools.is_empty() {
        let declarations: Vec<Value> = options.tools.iter().map(gemini_tool_definition).collect();
        object.insert(
            "tools".to_string(),
            json!([{ "functionDeclarations": declarations }]),
        );
    }
    body
}

/// The parts of one Gemini turn: plain text, a tool call, or a tool result.
fn gemini_parts(message: &WireMessage) -> Vec<Value> {
    if let Some(calls) = message
        .tool_calls
        .as_ref()
        .filter(|calls| !calls.is_empty())
    {
        return calls
            .iter()
            .map(|call| {
                json!({
                    "functionCall": {
                        "name": call.function.name,
                        "args": parse_tool_arguments(&call.function.arguments),
                    }
                })
            })
            .collect();
    }
    if let Some(tool_call_id) = &message.tool_call_id {
        return vec![json!({
            "functionResponse": {
                "name": tool_call_id,
                "response": { "content": message.content.clone().unwrap_or_default() },
            }
        })];
    }
    let mut parts = vec![json!({ "text": message.content.clone().unwrap_or_default() })];
    for image in message.images.iter().flatten() {
        parts.push(json!({ "inlineData": { "mimeType": image.mime_type, "data": image.data_base64 } }));
    }
    parts
}

/// Describes one tool the way Gemini expects.
#[must_use]
pub fn gemini_tool_definition(tool: &GatewayToolDefinition) -> Value {
    let mut declaration = json!({ "name": tool.name });
    if let Some(object) = declaration.as_object_mut() {
        if let Some(description) = &tool.description {
            object.insert("description".to_string(), json!(description));
        }
        if let Some(schema) = &tool.input_schema {
            object.insert("parameters".to_string(), schema.clone());
        }
    }
    declaration
}

/// Reads a Gemini generateContent response.
#[must_use]
pub fn gemini_response(payload: &Value) -> ChatCompletionResult {
    let candidate = payload
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first());
    let parts = candidate
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = parts
        .iter()
        .filter(|part| part.get("thought").and_then(Value::as_bool) != Some(true))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    let thought = parts
        .iter()
        .filter(|part| part.get("thought").and_then(Value::as_bool) == Some(true))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    let tool_calls = parts
        .iter()
        .filter(|part| part.get("functionCall").is_some())
        .enumerate()
        .map(|(index, part)| {
            let call = part
                .get("functionCall")
                .cloned()
                .unwrap_or_else(|| json!({}));
            ChatCompletionToolCall {
                id: call
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("call_{index}")),
                name: call
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                arguments: call.get("args").cloned().unwrap_or_else(|| json!({})),
            }
        })
        .collect();
    let reported = payload.get("usageMetadata");
    let usage = TokenUsage {
        input_tokens: reported
            .and_then(|usage| usage.get("promptTokenCount"))
            .and_then(Value::as_u64),
        output_tokens: reported
            .and_then(|usage| usage.get("candidatesTokenCount"))
            .and_then(Value::as_u64),
        total_tokens: reported
            .and_then(|usage| usage.get("totalTokenCount"))
            .and_then(Value::as_u64),
        reasoning_tokens: reported
            .and_then(|usage| usage.get("thoughtsTokenCount"))
            .and_then(Value::as_u64),
        cached_input_tokens: reported
            .and_then(|usage| usage.get("cachedContentTokenCount"))
            .and_then(Value::as_u64),
    };
    ChatCompletionResult {
        text,
        thought,
        tool_calls,
        finish_reason: candidate
            .and_then(|candidate| candidate.get("finishReason"))
            .and_then(Value::as_str)
            .map(str::to_string),
        usage,
    }
}

/// Reads one event from a Gemini stream.
#[must_use]
pub fn gemini_stream_event(data: &str) -> Option<ChatStreamEvent> {
    let payload: Value = serde_json::from_str(data).ok()?;
    let candidate = payload
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first());
    let parts = candidate
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut text = String::new();
    let mut thought = String::new();
    let mut tool_call: Option<Value> = None;
    for part in &parts {
        if let Some(part_text) = part.get("text").and_then(Value::as_str) {
            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                thought.push_str(part_text);
            } else {
                text.push_str(part_text);
            }
        }
        if tool_call.is_none() {
            if let Some(call) = part.get("functionCall") {
                tool_call = Some(call.clone());
            }
        }
    }
    if !text.is_empty() {
        return Some(ChatStreamEvent::Text { text });
    }
    if !thought.is_empty() {
        return Some(ChatStreamEvent::Text { text: thought });
    }
    let call = tool_call?;
    Some(ChatStreamEvent::ToolCall {
        index: 0,
        id: call.get("id").and_then(Value::as_str).map(str::to_string),
        name: call.get("name").and_then(Value::as_str).map(str::to_string),
        args_delta: call
            .get("args")
            .map(ToString::to_string)
            .filter(|args| args != "{}"),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        GeminiRequestOptions, gemini_request_body, gemini_response, gemini_stream_event,
        gemini_tool_definition,
    };
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
    fn puts_the_system_prompt_in_a_system_instruction() {
        let body = gemini_request_body(
            &[
                message(WireRole::System, "Be brief."),
                message(WireRole::User, "Hello"),
            ],
            &GeminiRequestOptions::default(),
        );

        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "Be brief.");
        assert_eq!(body["contents"].as_array().map(Vec::len), Some(1));
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "Hello");
    }

    #[test]
    fn calls_the_assistant_turn_the_model() {
        let body = gemini_request_body(
            &[message(WireRole::Assistant, "Hi")],
            &GeminiRequestOptions::default(),
        );

        assert_eq!(body["contents"][0]["role"], "model");
    }

    #[test]
    fn turns_tool_calls_into_function_calls() {
        let mut assistant = message(WireRole::Assistant, "");
        assistant.tool_calls = Some(vec![OpenAiToolCall {
            id: "call_1".to_string(),
            kind: "function".to_string(),
            function: OpenAiToolCallFunction {
                name: "read_file".to_string(),
                arguments: "{\"path\":\"a.txt\"}".to_string(),
            },
        }]);

        let body = gemini_request_body(&[assistant], &GeminiRequestOptions::default());

        let parts = body["contents"][0]["parts"].as_array().expect("parts");
        assert_eq!(parts[0]["functionCall"]["name"], "read_file");
        assert_eq!(
            parts[0]["functionCall"]["args"]["path"].as_str(),
            Some("a.txt")
        );
    }

    #[test]
    fn turns_a_tool_result_into_a_function_response() {
        let mut result = message(WireRole::Tool, "file contents");
        result.tool_call_id = Some("read_file".to_string());

        let body = gemini_request_body(&[result], &GeminiRequestOptions::default());

        let parts = body["contents"][0]["parts"].as_array().expect("parts");
        assert_eq!(parts[0]["functionResponse"]["name"], "read_file");
        assert_eq!(
            parts[0]["functionResponse"]["response"]["content"],
            "file contents"
        );
    }

    #[test]
    fn describes_a_tool_as_a_function_declaration() {
        let tool = GatewayToolDefinition {
            name: "read_file".to_string(),
            description: Some("Reads a file.".to_string()),
            input_schema: Some(json!({ "type": "object", "properties": {} })),
        };

        let declaration = gemini_tool_definition(&tool);

        assert_eq!(declaration["name"], "read_file");
        assert_eq!(declaration["description"], "Reads a file.");
        assert_eq!(declaration["parameters"]["type"], "object");
    }

    #[test]
    fn leaves_out_a_description_the_tool_does_not_have() {
        let tool = GatewayToolDefinition {
            name: "read_file".to_string(),
            description: None,
            input_schema: None,
        };

        let declaration = gemini_tool_definition(&tool);

        assert_eq!(declaration.get("description"), None);
        assert_eq!(declaration.get("parameters"), None);
    }

    #[test]
    fn puts_the_generation_settings_in_the_generation_config() {
        let body = gemini_request_body(
            &[message(WireRole::User, "Hello")],
            &GeminiRequestOptions {
                temperature: Some(0.2),
                max_tokens: Some(512),
                ..GeminiRequestOptions::default()
            },
        );

        assert_eq!(body["generationConfig"]["temperature"], 0.2);
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 512);
    }

    #[test]
    fn puts_the_tools_in_one_declaration_list() {
        let tool = GatewayToolDefinition {
            name: "read_file".to_string(),
            description: None,
            input_schema: None,
        };

        let body = gemini_request_body(
            &[message(WireRole::User, "Hello")],
            &GeminiRequestOptions {
                tools: vec![tool],
                ..GeminiRequestOptions::default()
            },
        );

        let declarations = body["tools"][0]["functionDeclarations"]
            .as_array()
            .expect("declarations");
        assert_eq!(declarations.len(), 1);
        assert_eq!(declarations[0]["name"], "read_file");
    }

    #[test]
    fn reads_the_text_the_thought_the_tool_calls_and_the_usage() {
        let payload = json!({
            "candidates": [{
                "content": { "parts": [
                    { "text": "Thinking hard", "thought": true },
                    { "text": "Hello" },
                    { "functionCall": { "id": "call_1", "name": "read_file", "args": { "path": "a.txt" } } }
                ] },
                "finishReason": "STOP"
            }],
            "usageMetadata": {
                "promptTokenCount": 20,
                "candidatesTokenCount": 8,
                "totalTokenCount": 28,
                "thoughtsTokenCount": 4,
                "cachedContentTokenCount": 3
            }
        });

        let result = gemini_response(&payload);

        assert_eq!(result.text, "Hello");
        assert_eq!(result.thought, "Thinking hard");
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].id, "call_1");
        assert_eq!(
            result.tool_calls[0].arguments["path"].as_str(),
            Some("a.txt")
        );
        assert_eq!(result.finish_reason.as_deref(), Some("STOP"));
        assert_eq!(result.usage.input_tokens, Some(20));
        assert_eq!(result.usage.output_tokens, Some(8));
        assert_eq!(result.usage.reasoning_tokens, Some(4));
        assert_eq!(result.usage.cached_input_tokens, Some(3));
    }

    #[test]
    fn reads_a_response_that_has_no_candidate() {
        let result = gemini_response(&json!({}));

        assert_eq!(result.text, "");
        assert!(result.tool_calls.is_empty());
    }

    #[test]
    fn reads_a_text_event() {
        let event = gemini_stream_event(
            "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hello\"}]}}]}",
        )
        .expect("a text event");

        assert!(matches!(event, super::ChatStreamEvent::Text { .. }));
    }

    #[test]
    fn reads_a_thought_event_as_text() {
        let event = gemini_stream_event(
            "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hmm\",\"thought\":true}]}}]}",
        )
        .expect("a thought event");

        match event {
            super::ChatStreamEvent::Text { text } => assert_eq!(text, "Hmm"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn reads_a_tool_call_event() {
        let event = gemini_stream_event(
            "{\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"read_file\",\"args\":{\"path\":\"a.txt\"}}}]}}]}",
        )
        .expect("a tool call event");

        match event {
            super::ChatStreamEvent::ToolCall {
                name, args_delta, ..
            } => {
                assert_eq!(name.as_deref(), Some("read_file"));
                assert!(args_delta.unwrap_or_default().contains("a.txt"));
            }
            other => panic!("expected a tool call, got {other:?}"),
        }
    }

    #[test]
    fn ignores_an_event_that_is_not_json() {
        assert!(gemini_stream_event("not json").is_none());
    }
}
