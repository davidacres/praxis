//! A full-duplex ACP connection: newline-delimited JSON-RPC over a child's stdio.
//!
//! Unlike [`super::client::AcpClient`] (which only understands `session/update` and plain
//! responses), this surfaces *everything the agent sends*: notifications and the requests an
//! agent makes of its client (`fs/read_text_file`, `fs/write_text_file`,
//! `session/request_permission`, …). The caller answers those with [`AcpConnection::respond`],
//! which is what lets Praxis gate file access and tool permissions.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

/// A JSON-RPC error object.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)
    }
}

/// Something the agent sent that is not a reply to one of our requests.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// A notification, e.g. `session/update`.
    Notification { method: String, params: Value },
    /// A request the agent expects an answer to. Reply with [`AcpConnection::respond`] or
    /// [`AcpConnection::respond_error`] using the same `id`.
    Request { id: Value, method: String, params: Value },
    /// The agent closed its stdout (it exited or crashed).
    Closed,
}

pub struct AcpSpawn {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// Extra environment on top of the inherited one.
    pub env: Vec<(String, String)>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

pub struct AcpConnection {
    child: Mutex<Option<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    next_id: AtomicU64,
    pending: Pending,
    stderr: Arc<Mutex<String>>,
}

impl AcpConnection {
    /// Spawns the agent and returns the connection plus the stream of [`Incoming`] messages.
    pub async fn spawn(options: AcpSpawn) -> Result<(Self, mpsc::UnboundedReceiver<Incoming>), String> {
        let mut command = Command::new(&options.command);
        command.args(&options.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        if let Some(cwd) = &options.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &options.env {
            command.env(key, value);
        }
        let mut child = command.spawn().map_err(|error| format!("Failed to start '{}': {error}", options.command))?;
        let stdin = child.stdin.take().ok_or("Could not capture the agent's stdin.")?;
        let stdout = child.stdout.take().ok_or("Could not capture the agent's stdout.")?;
        let mut stderr_pipe = child.stderr.take().ok_or("Could not capture the agent's stderr.")?;

        let pending: Pending = Arc::default();
        let (tx, rx) = mpsc::unbounded_channel();

        let stderr: Arc<Mutex<String>> = Arc::default();
        let stderr_sink = Arc::clone(&stderr);
        tokio::spawn(async move {
            let mut chunk = [0u8; 4096];
            while let Ok(read) = stderr_pipe.read(&mut chunk).await {
                if read == 0 {
                    break;
                }
                let mut text = stderr_sink.lock().await;
                text.push_str(&String::from_utf8_lossy(&chunk[..read]));
                // Keep only the tail; this is for diagnostics, not a log.
                if text.len() > 16_384 {
                    let cut = text.len() - 16_384;
                    text.drain(..cut);
                }
            }
        });

        let reader_pending = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(line.trim()) else { continue };
                route(&message, &reader_pending, &tx).await;
            }
            // Anything still waiting will never be answered.
            for (_, waiter) in reader_pending.lock().await.drain() {
                let _ = waiter.send(Err(RpcError { code: -32000, message: "The agent closed the connection.".into(), data: None }));
            }
            let _ = tx.send(Incoming::Closed);
        });

        let connection = Self {
            child: Mutex::new(Some(child)),
            stdin: Arc::new(Mutex::new(Some(stdin))),
            next_id: AtomicU64::new(1),
            pending,
            stderr,
        };
        Ok((connection, rx))
    }

    async fn write(&self, message: &Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("The agent connection is closed.")?;
        let mut line = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        line.push(b'\n');
        stdin.write_all(&line).await.map_err(|error| error.to_string())?;
        stdin.flush().await.map_err(|error| error.to_string())
    }

    /// Sends a request and waits for its reply.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply, wait) = oneshot::channel();
        self.pending.lock().await.insert(id, reply);
        if let Err(message) = self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await {
            self.pending.lock().await.remove(&id);
            return Err(RpcError { code: -32000, message, data: None });
        }
        wait.await.unwrap_or_else(|_| Err(RpcError { code: -32000, message: "The agent closed the connection.".into(), data: None }))
    }

    /// Sends a notification (no reply expected).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
    }

    /// Answers a request the agent made.
    pub async fn respond(&self, id: &Value, result: Value) -> Result<(), String> {
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result })).await
    }

    /// Refuses a request the agent made. The reason reaches the agent verbatim, so say why.
    pub async fn respond_error(&self, id: &Value, code: i64, message: &str) -> Result<(), String> {
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })).await
    }

    /// The tail of what the agent wrote to stderr, for error messages.
    pub async fn stderr_tail(&self) -> String {
        self.stderr.lock().await.clone()
    }

    /// Closes stdin and terminates the process.
    pub async fn shutdown(&self) {
        self.stdin.lock().await.take();
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

async fn route(message: &Value, pending: &Pending, tx: &mpsc::UnboundedSender<Incoming>) {
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").filter(|id| !id.is_null());
    match (method, id) {
        (Some(method), Some(id)) => {
            let _ = tx.send(Incoming::Request { id: id.clone(), method: method.to_owned(), params: message.get("params").cloned().unwrap_or(Value::Null) });
        }
        (Some(method), None) => {
            let _ = tx.send(Incoming::Notification { method: method.to_owned(), params: message.get("params").cloned().unwrap_or(Value::Null) });
        }
        (None, Some(id)) => {
            // A reply to an id we never sent (or already answered) is ignored.
            let Some(id) = id.as_u64() else { return };
            let Some(waiter) = pending.lock().await.remove(&id) else { return };
            let outcome = match message.get("error") {
                Some(error) => Err(RpcError {
                    code: error.get("code").and_then(Value::as_i64).unwrap_or(-32000),
                    message: error.get("message").and_then(Value::as_str).unwrap_or("Agent error").to_owned(),
                    data: error.get("data").cloned(),
                }),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = waiter.send(outcome);
        }
        (None, None) => {}
    }
}
