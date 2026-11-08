//! Stdio process supervisor and JSON-RPC stream driver for ACP agents.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc};

use super::protocol::{ACP_PROTOCOL_VERSION, AcpPromptResponse, AcpSessionUpdate};
use crate::mcp::types::{JsonRpcRequest, JsonRpcResponse};

pub const ACP_CONNECT_TIMEOUT_SECS: u64 = 30;
pub const ACP_PROMPT_TIMEOUT_SECS: u64 = 600;

pub struct AcpClientOptions {
    pub command: String,
    pub args: Vec<String>,
    pub env: Option<BTreeMap<String, String>>,
    pub working_directory: Option<String>,
}

/// An active ACP client supervising an agent CLI child process.
pub struct AcpClient {
    child: Option<Child>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    next_id: AtomicU64,
    update_tx: mpsc::UnboundedSender<AcpSessionUpdate>,
    update_rx: Arc<Mutex<mpsc::UnboundedReceiver<AcpSessionUpdate>>>,
    active_session_id: Arc<Mutex<Option<String>>>,
    stdout_reader_handle: Option<tokio::task::JoinHandle<()>>,
    pending_responses: Arc<Mutex<BTreeMap<u64, tokio::sync::oneshot::Sender<JsonRpcResponse>>>>,
}

impl AcpClient {
    pub async fn spawn(options: AcpClientOptions) -> Result<Self, String> {
        let mut cmd = Command::new(&options.command);
        cmd.args(&options.args);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        if let Some(wd) = options.working_directory {
            cmd.current_dir(wd);
        }

        if let Some(env_map) = options.env {
            for (k, v) in env_map {
                cmd.env(k, v);
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn ACP agent '{}': {e}", options.command))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture stdin for ACP agent".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture stdout for ACP agent".to_string())?;

        let (update_tx, update_rx) = mpsc::unbounded_channel();
        let pending_responses: Arc<
            Mutex<BTreeMap<u64, tokio::sync::oneshot::Sender<JsonRpcResponse>>>,
        > = Arc::new(Mutex::new(BTreeMap::new()));

        let pending_clone = Arc::clone(&pending_responses);
        let update_tx_clone = update_tx.clone();

        let stdout_reader_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                // Check if it's a notification
                if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                    let method = value.get("method").and_then(Value::as_str);
                    if method == Some("session/update") {
                        if let Some(params) = value.get("params") {
                            if let Some(update_val) = params.get("update") {
                                if let Ok(update) =
                                    serde_json::from_value::<AcpSessionUpdate>(update_val.clone())
                                {
                                    let _ = update_tx_clone.send(update);
                                    continue;
                                }
                            }
                        }
                    }
                }

                // Check if it's a response to a pending request
                if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(trimmed) {
                    if let Some(id_u64) = resp.id.as_u64() {
                        let mut map = pending_clone.lock().await;
                        if let Some(sender) = map.remove(&id_u64) {
                            let _ = sender.send(resp);
                        }
                    }
                }
            }
        });

        Ok(Self {
            child: Some(child),
            stdin: Arc::new(Mutex::new(Some(stdin))),
            next_id: AtomicU64::new(1),
            update_tx,
            update_rx: Arc::new(Mutex::new(update_rx)),
            active_session_id: Arc::new(Mutex::new(None)),
            stdout_reader_handle: Some(stdout_reader_handle),
            pending_responses,
        })
    }

    async fn send_request(
        &self,
        method: &str,
        params: Option<Value>,
        timeout_secs: u64,
    ) -> Result<JsonRpcResponse, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = JsonRpcRequest::new(id, method, params);
        let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        line.push('\n');

        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.pending_responses.lock().await;
            pending.insert(id, tx);
        }

        {
            let mut stdin_guard = self.stdin.lock().await;
            let stdin = stdin_guard
                .as_mut()
                .ok_or_else(|| "Stdin closed".to_string())?;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("Failed to write to ACP stdin: {e}"))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush ACP stdin: {e}"))?;
        }

        tokio::time::timeout(Duration::from_secs(timeout_secs), rx)
            .await
            .map_err(|_| format!("ACP request '{method}' timed out after {timeout_secs}s"))?
            .map_err(|_| "ACP response channel dropped".to_string())
    }

    /// Initializes connection with the agent process.
    pub async fn initialize(&self) -> Result<Value, String> {
        let params = json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {
                "tools": true
            }
        });

        let resp = self
            .send_request("initialize", Some(params), ACP_CONNECT_TIMEOUT_SECS)
            .await?;

        if let Some(err) = resp.error {
            return Err(format!("ACP initialize failed: {}", err.message));
        }

        resp.result
            .ok_or_else(|| "Empty initialize result".to_string())
    }

    /// Creates a new ACP session with the agent.
    pub async fn new_session(&self, working_directory: Option<&str>) -> Result<String, String> {
        let params = json!({
            "workingDirectory": working_directory.unwrap_or(".")
        });

        let resp = self
            .send_request("session/new", Some(params), ACP_CONNECT_TIMEOUT_SECS)
            .await?;

        if let Some(err) = resp.error {
            return Err(format!("ACP session/new failed: {}", err.message));
        }

        let session_id = resp
            .result
            .as_ref()
            .and_then(|r| r.get("sessionId"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing sessionId in session/new response".to_string())?
            .to_string();

        *self.active_session_id.lock().await = Some(session_id.clone());
        Ok(session_id)
    }

    /// Sets a configuration option for the active session (e.g. model, reasoning effort).
    pub async fn set_config_option(&self, config_id: &str, value: &str) -> Result<(), String> {
        let session_id = {
            let guard = self.active_session_id.lock().await;
            guard
                .clone()
                .ok_or_else(|| "No active session".to_string())?
        };

        let params = json!({
            "sessionId": session_id,
            "configId": config_id,
            "value": value
        });

        let resp = self
            .send_request(
                "session/set_config_option",
                Some(params),
                ACP_CONNECT_TIMEOUT_SECS,
            )
            .await?;

        if let Some(err) = resp.error {
            return Err(format!("ACP set_config_option failed: {}", err.message));
        }

        Ok(())
    }

    /// Sends a prompt turn to the active session and waits for completion.
    pub async fn prompt(&self, prompt_text: &str) -> Result<AcpPromptResponse, String> {
        let session_id = {
            let guard = self.active_session_id.lock().await;
            guard
                .clone()
                .ok_or_else(|| "No active session".to_string())?
        };

        let params = json!({
            "sessionId": session_id,
            "prompt": [
                {
                    "type": "text",
                    "text": prompt_text
                }
            ]
        });

        let resp = self
            .send_request("session/prompt", Some(params), ACP_PROMPT_TIMEOUT_SECS)
            .await?;

        if let Some(err) = resp.error {
            return Err(format!("ACP prompt turn failed: {}", err.message));
        }

        let result = resp
            .result
            .ok_or_else(|| "Empty prompt result".to_string())?;
        serde_json::from_value::<AcpPromptResponse>(result)
            .map_err(|e| format!("Failed to parse prompt response: {e}"))
    }

    /// Polls or receives the next session update notification.
    pub async fn next_update(&self) -> Option<AcpSessionUpdate> {
        let mut rx = self.update_rx.lock().await;
        rx.recv().await
    }

    /// Returns a sender handle to inject updates (useful for testing or bridge mocks).
    pub fn update_sender(&self) -> mpsc::UnboundedSender<AcpSessionUpdate> {
        self.update_tx.clone()
    }

    /// Sends cancellation signal to the active session.
    pub async fn cancel(&self) -> Result<(), String> {
        let session_id = {
            let guard = self.active_session_id.lock().await;
            guard.clone()
        };

        if let Some(id) = session_id {
            let params = json!({ "sessionId": id });
            let _ = self.send_request("session/cancel", Some(params), 5).await;
        }

        Ok(())
    }

    /// Shuts down the child process.
    pub async fn shutdown(&mut self) -> Result<(), String> {
        let _ = self.cancel().await;
        if let Some(handle) = self.stdout_reader_handle.take() {
            handle.abort();
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
        }
        Ok(())
    }
}
