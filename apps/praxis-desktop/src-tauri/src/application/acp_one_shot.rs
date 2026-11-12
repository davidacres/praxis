//! A read-only, one-turn prompt to an ACP CLI agent (`AcpAgentHost.promptOnce`): spawn the agent,
//! `initialize`, `session/new`, optionally pick a model, send one prompt, collect the streamed
//! reply, and stop the process. No tracked session is created, and nothing the agent asks to do
//! is granted: permission requests are cancelled and file/terminal requests are refused.

use std::sync::Arc;
use std::time::Duration;

use praxis_ai::acp::connection::{AcpConnection, AcpSpawn, Incoming};
use praxis_ai::providers::environment::effective_path;
use praxis_ai::providers::registry::resolve_executable;
use serde_json::{Value, json};

/// The reply text carried by one `session/update` notification, if it is an assistant text chunk.
fn message_chunk(params: &Value) -> Option<&str> {
    let update = &params["update"];
    (update["sessionUpdate"] == "agent_message_chunk" && update["content"]["type"] == "text")
        .then(|| update["content"]["text"].as_str())
        .flatten()
}

pub async fn prompt_once(
    command: &str,
    args: Vec<String>,
    cwd: &str,
    model: Option<&str>,
    prompt: &str,
    timeout: Duration,
) -> Result<String, String> {
    let resolved = resolve_executable(command, effective_path())
        .ok_or_else(|| format!("Failed to start '{command}': spawn {command} ENOENT"))?;
    let (connection, mut incoming) = AcpConnection::spawn(AcpSpawn {
        command: resolved.to_string_lossy().into_owned(),
        args,
        cwd: Some(cwd.to_owned()).filter(|cwd| !cwd.is_empty()),
        env: vec![("PATH".into(), effective_path().to_owned())],
    })
    .await?;
    let connection = Arc::new(connection);
    let reply = Arc::new(std::sync::Mutex::new(String::new()));
    let pump = {
        let connection = Arc::clone(&connection);
        let reply = Arc::clone(&reply);
        tokio::spawn(async move {
            while let Some(message) = incoming.recv().await {
                match message {
                    Incoming::Notification { method, params } if method == "session/update" => {
                        if let Some(text) = message_chunk(&params) {
                            reply
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .push_str(text);
                        }
                    }
                    Incoming::Notification { .. } => {}
                    Incoming::Request { id, method, .. } => {
                        if method == "session/request_permission" {
                            let _ = connection
                                .respond(&id, json!({ "outcome": { "outcome": "cancelled" } }))
                                .await;
                        } else {
                            let _ = connection
                                .respond_error(
                                    &id,
                                    -32601,
                                    "Not available during a one-shot prompt.",
                                )
                                .await;
                        }
                    }
                    Incoming::Closed => break,
                }
            }
        })
    };
    let outcome = tokio::time::timeout(timeout, async {
        connection
            .request(
                "initialize",
                json!({ "protocolVersion": 1, "clientCapabilities": {} }),
            )
            .await
            .map_err(|e| e.to_string())?;
        let session = connection
            .request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
            .await
            .map_err(|e| e.to_string())?;
        let session_id = session["sessionId"]
            .as_str()
            .ok_or("The agent did not return a session id.")?
            .to_owned();
        if let Some(model) = model.filter(|m| !m.is_empty()) {
            // Not every agent exposes a model option; the prompt still runs.
            let _ = connection
                .request(
                    "session/set_config_option",
                    json!({ "sessionId": session_id, "configId": "model", "value": model }),
                )
                .await;
        }
        connection
            .request(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": prompt }] }),
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(())
    })
    .await;
    let tail = connection.stderr_tail().await;
    connection.shutdown().await;
    pump.abort();
    match outcome {
        Err(_) => Err(format!(
            "The CLI agent did not answer within {}s.",
            timeout.as_secs()
        )),
        Ok(Err(error)) => Err(if tail.trim().is_empty() {
            error
        } else {
            format!("{error}\n{}", tail.trim())
        }),
        Ok(Ok(())) => {
            let text = reply
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .trim()
                .to_owned();
            if text.is_empty() {
                Err("The CLI agent returned an empty response.".into())
            } else {
                Ok(text)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_assistant_text_chunks_are_reply_text() {
        let chunk = json!({ "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "hi" } } });
        assert_eq!(message_chunk(&chunk), Some("hi"));
        let thought = json!({ "update": { "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "hm" } } });
        assert_eq!(message_chunk(&thought), None);
        let image = json!({ "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "image" } } });
        assert_eq!(message_chunk(&image), None);
    }

    #[test]
    fn a_missing_agent_is_a_stated_failure() {
        let error = super::super::runtime::block_on(prompt_once(
            "praxis-no-such-agent",
            Vec::new(),
            "",
            None,
            "hello",
            Duration::from_secs(2),
        ))
        .expect_err("no agent");
        assert!(error.contains("ENOENT"), "{error}");
    }
}
