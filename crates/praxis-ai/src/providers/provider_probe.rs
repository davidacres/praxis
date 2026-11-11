//! Tests what an OpenAI-compatible endpoint actually supports, in the order a session depends on
//! it. Ports `providerProbe.ts`. Each step records pass / fail / skipped with the server's own
//! reason; nothing here returns an error. At most four small requests (one model list and three
//! completions capped at a few dozen tokens), run on demand only.

use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};

use super::model_catalog::{GatewayOptions, KeyAuth, endpoint};

const STEP_TIMEOUT: Duration = Duration::from_secs(20);

struct Http {
    status: u16,
    body: String,
}

async fn send(options: &GatewayOptions, post: bool, suffix: &str, payload: Option<&Value>) -> Result<Http, String> {
    let client = reqwest::Client::builder().timeout(STEP_TIMEOUT).build().map_err(|e| e.to_string())?;
    let url = endpoint(options, suffix);
    let mut request = if post { client.post(&url) } else { client.get(&url) };
    request = request.header("Accept", "application/json");
    for (name, value) in &options.headers {
        request = request.header(name, value);
    }
    if let Some(key) = options.api_key.as_deref().filter(|key| !key.is_empty()) {
        request = match &options.auth {
            KeyAuth::Bearer => request.header("Authorization", format!("Bearer {key}")),
            KeyAuth::Header(name) => request.header(name, key),
            KeyAuth::None => request,
        };
    }
    if let Some(payload) = payload {
        request = request.json(payload);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok(Http { status, body })
}

fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// A short, key-free reason: the provider's own `error.message` when it sends one.
fn reason(result: &Http, api_key: Option<&str>) -> String {
    let parsed = parse(&result.body).unwrap_or(Value::Null);
    let raw = parsed["error"].as_str().or_else(|| parsed["error"]["message"].as_str()).or_else(|| parsed["message"].as_str()).unwrap_or(&result.body);
    let mut text: String = raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect();
    if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        text = text.replace(key, "•••");
    }
    if text.is_empty() { format!("HTTP {}", result.status) } else { format!("HTTP {}: {text}", result.status) }
}

fn network_reason(error: &str) -> String {
    format!("Can't reach the server — {error}")
}

/// Streamed SSE body → (chunks that parsed, whether any chunk carried `usage`).
fn read_stream(body: &str) -> (usize, bool) {
    let (mut chunks, mut usage) = (0, false);
    for line in body.lines() {
        let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else { continue };
        if data == "[DONE]" {
            continue;
        }
        let Some(parsed) = parse(data) else { continue };
        chunks += 1;
        if parsed["usage"].is_object() {
            usage = true;
        }
    }
    (chunks, usage)
}

fn step(id: &str, status: &str, detail: impl Into<String>) -> Value {
    json!({ "id": id, "status": status, "detail": detail.into() })
}

/// Runs the probe and returns `{ steps, capabilities, models }`.
pub async fn probe_openai_compatible(options: &GatewayOptions, preferred_model: Option<&str>) -> Value {
    let key = options.api_key.as_deref();
    let mut steps: Vec<Value> = Vec::new();
    let mut caps = json!({ "models": false, "chat": false, "streaming": false, "streamUsage": false, "tools": false, "probedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true) });
    let mut models: Vec<String> = Vec::new();
    let skip = |steps: &mut Vec<Value>, ids: &[&str], detail: &str| ids.iter().for_each(|id| steps.push(step(id, "skipped", detail)));
    macro_rules! finish {
        () => {
            return json!({ "steps": steps, "capabilities": caps, "models": models })
        };
    }

    // 1 — reachable, key accepted, model list.
    match send(options, false, "/models", None).await {
        Ok(listed) if listed.status == 401 || listed.status == 403 => {
            steps.push(step("models", "fail", format!("API key rejected — {}", reason(&listed, key))));
            skip(&mut steps, &["chat", "streaming", "tools"], "Fix the key first.");
            finish!();
        }
        Ok(listed) if (200..300).contains(&listed.status) => {
            models = parse(&listed.body).and_then(|body| body["data"].as_array().cloned()).unwrap_or_default().iter().filter_map(|m| m["id"].as_str().filter(|id| !id.is_empty()).map(str::to_owned)).collect();
            caps["models"] = json!(true);
            steps.push(step("models", "pass", format!("{} model{} listed", models.len(), if models.len() == 1 { "" } else { "s" })));
        }
        Ok(listed) => steps.push(step("models", "fail", format!("No model list ({}). Add model ids by hand.", reason(&listed, key)))),
        Err(error) => {
            steps.push(step("models", "fail", network_reason(&error)));
            skip(&mut steps, &["chat", "streaming", "tools"], "The server did not respond.");
            finish!();
        }
    }

    let Some(model) = preferred_model.map(str::trim).filter(|m| !m.is_empty()).map(str::to_owned).or_else(|| models.first().cloned()) else {
        skip(&mut steps, &["chat", "streaming", "tools"], "Choose a model to test against.");
        finish!();
    };
    caps["model"] = json!(model);
    let messages = json!([{ "role": "user", "content": "Reply with the single word: ok" }]);

    // 2 — a plain completion.
    match send(options, true, "/chat/completions", Some(&json!({ "model": model, "messages": messages, "max_tokens": 16, "stream": false }))).await {
        Ok(chat) if (200..300).contains(&chat.status) && parse(&chat.body).is_some_and(|b| b["choices"].as_array().is_some_and(|c| !c.is_empty())) => {
            caps["chat"] = json!(true);
            steps.push(step("chat", "pass", format!("Completion returned by {model}")));
        }
        Ok(chat) => {
            steps.push(step("chat", "fail", if chat.status >= 400 { reason(&chat, key) } else { "The response had no choices.".into() }));
            skip(&mut steps, &["streaming", "tools"], "Chat has to work first.");
            finish!();
        }
        Err(error) => {
            steps.push(step("chat", "fail", network_reason(&error)));
            skip(&mut steps, &["streaming", "tools"], "Chat has to work first.");
            finish!();
        }
    }

    // 3 — streaming, and whether token usage rides on it. A server that rejects `stream_options`
    // still streams; it just can't report usage that way.
    let streamed = async {
        let mut result = send(options, true, "/chat/completions", Some(&json!({ "model": model, "messages": messages, "max_tokens": 16, "stream": true, "stream_options": { "include_usage": true } }))).await?;
        let mut rejected = false;
        if result.status == 400 || result.status == 422 {
            rejected = true;
            result = send(options, true, "/chat/completions", Some(&json!({ "model": model, "messages": messages, "max_tokens": 16, "stream": true }))).await?;
        }
        Ok::<_, String>((result, rejected))
    }
    .await;
    match streamed {
        Ok((result, rejected)) => {
            let (chunks, usage) = if (200..300).contains(&result.status) { read_stream(&result.body) } else { (0, false) };
            if chunks > 0 {
                caps["streaming"] = json!(true);
                caps["streamUsage"] = json!(usage);
                steps.push(step("streaming", "pass", if usage { "Streams, and reports token usage" } else if rejected { "Streams, but rejected the usage option — token counts will be missing" } else { "Streams, but sent no token usage" }));
            } else {
                steps.push(step("streaming", "fail", if result.status >= 400 { reason(&result, key) } else { "No stream chunks arrived.".into() }));
            }
        }
        Err(error) => steps.push(step("streaming", "fail", network_reason(&error))),
    }

    // 4 — tool calling, which agent sessions and workflows cannot work without.
    let tool = json!({ "type": "function", "function": { "name": "get_time", "description": "Returns the current time in a timezone.",
        "parameters": { "type": "object", "properties": { "timezone": { "type": "string", "description": "IANA timezone, e.g. UTC" } }, "required": ["timezone"] } } });
    let payload = json!({ "model": model, "messages": [{ "role": "user", "content": "What time is it in UTC? Use the get_time tool; do not answer in text." }],
        "tools": [tool], "tool_choice": "auto", "max_tokens": 64, "stream": false });
    match send(options, true, "/chat/completions", Some(&payload)).await {
        Ok(reply) => {
            let called = parse(&reply.body).is_some_and(|b| b["choices"][0]["message"]["tool_calls"].as_array().is_some_and(|calls| calls.iter().any(|c| c["function"]["name"] == "get_time")));
            if (200..300).contains(&reply.status) && called {
                caps["tools"] = json!(true);
                steps.push(step("tools", "pass", "Called the test tool"));
            } else {
                steps.push(step("tools", "fail", if reply.status >= 400 {
                    format!("{}. Agent sessions and workflows won't offer this endpoint.", reason(&reply, key))
                } else {
                    "The model answered in text instead of calling the tool. Agent sessions, ticket reviews and workflows won't offer this endpoint; AI recommendations still can.".into()
                }));
            }
        }
        Err(error) => steps.push(step("tools", "fail", network_reason(&error))),
    }
    finish!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A tiny OpenAI-compatible server. `tools` decides whether it answers the tool probe with a call.
    async fn server(tools: bool, reject_stream_options: bool) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let tools = Arc::new(tools);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let tools = Arc::clone(&tools);
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 16384];
                    let read = socket.read(&mut buffer).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let (status, content_type, body) = if request.starts_with("GET /v1/models") {
                        (200, "application/json", r#"{"data":[{"id":"probe-model"}]}"#.to_owned())
                    } else if request.contains("\"stream\":true") {
                        if reject_stream_options && request.contains("stream_options") {
                            (400, "application/json", r#"{"error":{"message":"unknown field stream_options"}}"#.to_owned())
                        } else {
                            (200, "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n".to_owned())
                        }
                    } else if request.contains("get_time") && *tools {
                        (200, "application/json", r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":"get_time"}}]}}]}"#.to_owned())
                    } else {
                        (200, "application/json", r#"{"choices":[{"message":{"content":"ok"}}]}"#.to_owned())
                    };
                    let _ = socket.write_all(format!("HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
                });
            }
        });
        port
    }

    fn statuses(result: &Value) -> Vec<(String, String)> {
        result["steps"].as_array().expect("steps").iter().map(|s| (s["id"].as_str().unwrap_or_default().to_owned(), s["status"].as_str().unwrap_or_default().to_owned())).collect()
    }

    #[tokio::test]
    async fn a_fully_capable_endpoint_passes_every_step() {
        let port = server(true, false).await;
        let result = probe_openai_compatible(&GatewayOptions::new(format!("http://127.0.0.1:{port}"), Some("k".into())), None).await;
        assert!(statuses(&result).iter().all(|(_, status)| status == "pass"), "{:?}", statuses(&result));
        assert_eq!((result["capabilities"]["tools"].as_bool(), result["capabilities"]["streaming"].as_bool(), result["capabilities"]["model"].as_str()), (Some(true), Some(true), Some("probe-model")));
        assert_eq!(result["models"], json!(["probe-model"]));
    }

    #[tokio::test]
    async fn an_endpoint_that_cannot_call_tools_is_reported_as_chat_only() {
        let port = server(false, false).await;
        let result = probe_openai_compatible(&GatewayOptions::new(format!("http://127.0.0.1:{port}"), None), Some("any")).await;
        assert_eq!(statuses(&result).last().map(|s| s.1.as_str()), Some("fail"));
        assert_eq!((result["capabilities"]["chat"].as_bool(), result["capabilities"]["tools"].as_bool()), (Some(true), Some(false)));
        assert!(result["steps"][3]["detail"].as_str().unwrap_or_default().contains("answered in text"));
    }

    #[tokio::test]
    async fn a_server_that_rejects_stream_options_still_streams_without_usage() {
        let port = server(true, true).await;
        let result = probe_openai_compatible(&GatewayOptions::new(format!("http://127.0.0.1:{port}"), None), None).await;
        assert_eq!((result["capabilities"]["streaming"].as_bool(), result["capabilities"]["streamUsage"].as_bool()), (Some(true), Some(false)));
        assert!(result["steps"][2]["detail"].as_str().unwrap_or_default().contains("rejected the usage option"));
    }

    #[tokio::test]
    async fn an_unreachable_server_fails_the_first_step_and_skips_the_rest() {
        let result = probe_openai_compatible(&GatewayOptions::new("http://127.0.0.1:9", None), None).await;
        assert_eq!(statuses(&result), [("models", "fail"), ("chat", "skipped"), ("streaming", "skipped"), ("tools", "skipped")].map(|(a, b)| (a.to_owned(), b.to_owned())));
        assert!(result["steps"][0]["detail"].as_str().unwrap_or_default().starts_with("Can't reach the server"));
    }

    #[test]
    fn reasons_use_the_servers_message_and_never_echo_the_key() {
        let http = Http { status: 401, body: r#"{"error":{"message":"Bad key sk-live-123 given"}}"#.into() };
        assert_eq!(reason(&http, Some("sk-live-123")), "HTTP 401: Bad key ••• given");
        assert_eq!(reason(&Http { status: 500, body: String::new() }, None), "HTTP 500");
    }
}
