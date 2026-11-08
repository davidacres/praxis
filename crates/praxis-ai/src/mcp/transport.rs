//! Transport implementations for Model Context Protocol (MCP): Stdio and HTTP.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::types::{
    CALL_TIMEOUT_SECS, CONNECT_TIMEOUT_SECS, CallToolResult, JsonRpcRequest, JsonRpcResponse,
    MAX_RESULT_CHARS, McpToolInfo,
};

/// Flattens an MCP tool result payload into the text representation for models.
pub fn result_text(response: &Value) -> CallToolResult {
    let root = if let Some(res) = response.get("result") {
        res
    } else {
        response
    };

    let is_error = root
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut parts: Vec<String> = Vec::new();
    if let Some(content_arr) = root.get("content").and_then(Value::as_array) {
        for block in content_arr {
            let Some(obj) = block.as_object() else {
                continue;
            };
            let block_type = obj.get("type").and_then(Value::as_str).unwrap_or_default();
            if block_type == "text" {
                if let Some(t) = obj.get("text").and_then(Value::as_str) {
                    parts.push(t.to_string());
                }
            } else if block_type == "resource" {
                if let Some(res_obj) = obj.get("resource").and_then(Value::as_object) {
                    if let Some(t) = res_obj.get("text").and_then(Value::as_str) {
                        parts.push(t.to_string());
                    }
                }
            } else if !block_type.is_empty() {
                parts.push(format!("[{block_type} content omitted]"));
            }
        }
    }

    if parts.is_empty() {
        if let Some(structured) = root.get("structuredContent") {
            if let Ok(serialized) = serde_json::to_string(structured) {
                parts.push(serialized);
            }
        }
    }

    let mut content = if parts.is_empty() {
        "(no output)".to_string()
    } else {
        parts.join("\n")
    };

    let char_count = content.chars().count();
    if char_count > MAX_RESULT_CHARS {
        let truncated: String = content.chars().take(MAX_RESULT_CHARS).collect();
        content = format!(
            "{truncated}\n… output truncated ({} characters).",
            group_thousands(char_count)
        );
    }

    CallToolResult {
        ok: !is_error,
        content,
    }
}

/// Formats `n` with comma thousands separators, matching `toLocaleString()` in the en-US
/// locale the TypeScript bridge produced its truncation notice in.
fn group_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// Abstract connection to an MCP server.
#[async_trait]
pub trait McpTransportConnection: Send + Sync {
    async fn initialize(&mut self) -> Result<Option<String>, String>;
    async fn list_tools(&mut self) -> Result<Vec<McpToolInfo>, String>;
    async fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<CallToolResult, String>;
    async fn close(&mut self) -> Result<(), String>;
}

/// Stdio-based MCP transport running a child process.
pub struct StdioTransport {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    reader: Option<tokio::io::Lines<BufReader<ChildStdout>>>,
    next_id: AtomicU64,
}

impl StdioTransport {
    pub async fn spawn(
        command: &str,
        args: &[String],
        env: &Option<BTreeMap<String, String>>,
    ) -> Result<Self, String> {
        let mut cmd = Command::new(command);
        cmd.args(args);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        if let Some(env_map) = env {
            for (k, v) in env_map {
                cmd.env(k, v);
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn stdio MCP command '{command}': {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open child process stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open child process stdout".to_string())?;

        let reader = BufReader::new(stdout).lines();

        Ok(Self {
            child: Some(child),
            stdin: Some(stdin),
            reader: Some(reader),
            next_id: AtomicU64::new(1),
        })
    }

    async fn send_request(
        &mut self,
        method: &str,
        params: Option<Value>,
        timeout_secs: u64,
    ) -> Result<JsonRpcResponse, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = JsonRpcRequest::new(id, method, params);
        let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        line.push('\n');

        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "Stdin closed".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdio MCP stdin: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdio MCP stdin: {e}"))?;

        let reader = self
            .reader
            .as_mut()
            .ok_or_else(|| "Stdout closed".to_string())?;
        let duration = Duration::from_secs(timeout_secs);

        let read_future = async {
            while let Ok(Some(resp_line)) = reader.next_line().await {
                let trimmed = resp_line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(trimmed) {
                    if resp.id == json!(id) || resp.id == json!(id.to_string()) {
                        return Ok(resp);
                    }
                }
            }
            Err("Stdio stream closed before response arrived".to_string())
        };

        tokio::time::timeout(duration, read_future)
            .await
            .map_err(|_| format!("MCP stdio request '{method}' timed out after {timeout_secs}s"))?
    }
}

#[async_trait]
impl McpTransportConnection for StdioTransport {
    async fn initialize(&mut self) -> Result<Option<String>, String> {
        let params = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "praxis",
                "version": "0.0.1"
            }
        });

        let resp = self
            .send_request("initialize", Some(params), CONNECT_TIMEOUT_SECS)
            .await?;
        if let Some(err) = resp.error {
            return Err(format!("MCP initialize error: {}", err.message));
        }

        let server_name = resp
            .result
            .as_ref()
            .and_then(|r| r.get("serverInfo"))
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .map(ToString::to_string);

        Ok(server_name)
    }

    async fn list_tools(&mut self) -> Result<Vec<McpToolInfo>, String> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;

        for _ in 0..10 {
            let params = cursor.as_ref().map(|c| json!({ "cursor": c }));
            let resp = self
                .send_request("tools/list", params, CONNECT_TIMEOUT_SECS)
                .await?;
            if let Some(err) = resp.error {
                return Err(format!("MCP tools/list error: {}", err.message));
            }

            let Some(result) = resp.result else { break };
            if let Some(tool_arr) = result.get("tools").and_then(Value::as_array) {
                for item in tool_arr {
                    if let Ok(info) = serde_json::from_value::<McpToolInfo>(item.clone()) {
                        tools.push(info);
                    }
                }
            }

            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if cursor.is_none() {
                break;
            }
        }

        Ok(tools)
    }

    async fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<CallToolResult, String> {
        let params = json!({
            "name": name,
            "arguments": arguments
        });

        let resp = self
            .send_request("tools/call", Some(params), CALL_TIMEOUT_SECS)
            .await?;
        if let Some(err) = resp.error {
            return Ok(CallToolResult::failure(format!(
                "Tool {name} error: {}",
                err.message
            )));
        }

        let Some(res) = resp.result else {
            return Ok(CallToolResult::failure(format!(
                "Tool {name} returned empty result"
            )));
        };

        Ok(result_text(&res))
    }

    async fn close(&mut self) -> Result<(), String> {
        self.stdin.take();
        self.reader.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
        }
        Ok(())
    }
}

/// HTTP-based MCP transport.
pub struct HttpTransport {
    url: String,
    headers: Option<BTreeMap<String, String>>,
    client: reqwest::Client,
    next_id: AtomicU64,
}

impl HttpTransport {
    pub fn new(url: String, headers: Option<BTreeMap<String, String>>) -> Self {
        Self {
            url,
            headers,
            client: reqwest::Client::new(),
            next_id: AtomicU64::new(1),
        }
    }

    async fn post_request(
        &self,
        method: &str,
        params: Option<Value>,
        timeout_secs: u64,
    ) -> Result<JsonRpcResponse, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req_body = JsonRpcRequest::new(id, method, params);

        let mut req_builder = self
            .client
            .post(&self.url)
            .timeout(Duration::from_secs(timeout_secs))
            .json(&req_body);

        if let Some(headers) = &self.headers {
            for (k, v) in headers {
                req_builder = req_builder.header(k, v);
            }
        }

        let resp = req_builder
            .send()
            .await
            .map_err(|e| format!("HTTP request to {} failed: {e}", self.url))?;

        if !resp.status().is_success() {
            return Err(format!("HTTP error {}: {}", resp.status(), self.url));
        }

        let json_resp: JsonRpcResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse JSON-RPC response from {}: {e}", self.url))?;

        Ok(json_resp)
    }
}

#[async_trait]
impl McpTransportConnection for HttpTransport {
    async fn initialize(&mut self) -> Result<Option<String>, String> {
        let params = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "praxis",
                "version": "0.0.1"
            }
        });

        let resp = self
            .post_request("initialize", Some(params), CONNECT_TIMEOUT_SECS)
            .await?;
        if let Some(err) = resp.error {
            return Err(format!("MCP initialize error: {}", err.message));
        }

        let server_name = resp
            .result
            .as_ref()
            .and_then(|r| r.get("serverInfo"))
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .map(ToString::to_string);

        Ok(server_name)
    }

    async fn list_tools(&mut self) -> Result<Vec<McpToolInfo>, String> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;

        for _ in 0..10 {
            let params = cursor.as_ref().map(|c| json!({ "cursor": c }));
            let resp = self
                .post_request("tools/list", params, CONNECT_TIMEOUT_SECS)
                .await?;
            if let Some(err) = resp.error {
                return Err(format!("MCP tools/list error: {}", err.message));
            }

            let Some(result) = resp.result else { break };
            if let Some(tool_arr) = result.get("tools").and_then(Value::as_array) {
                for item in tool_arr {
                    if let Ok(info) = serde_json::from_value::<McpToolInfo>(item.clone()) {
                        tools.push(info);
                    }
                }
            }

            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if cursor.is_none() {
                break;
            }
        }

        Ok(tools)
    }

    async fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<CallToolResult, String> {
        let params = json!({
            "name": name,
            "arguments": arguments
        });

        let resp = self
            .post_request("tools/call", Some(params), CALL_TIMEOUT_SECS)
            .await?;
        if let Some(err) = resp.error {
            return Ok(CallToolResult::failure(format!(
                "Tool {name} error: {}",
                err.message
            )));
        }

        let Some(res) = resp.result else {
            return Ok(CallToolResult::failure(format!(
                "Tool {name} returned empty result"
            )));
        };

        Ok(result_text(&res))
    }

    async fn close(&mut self) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_text_and_resource_content_blocks() {
        let resp = json!({
            "content": [
                { "type": "text", "text": "First line" },
                { "type": "resource", "resource": { "text": "Second line from resource" } },
                { "type": "image", "data": "abc" }
            ],
            "isError": false
        });

        let res = result_text(&resp);
        assert!(res.ok);
        assert_eq!(
            res.content,
            "First line\nSecond line from resource\n[image content omitted]"
        );
    }

    #[test]
    fn flattens_structured_content_when_content_array_is_empty() {
        let resp = json!({
            "structuredContent": { "status": "ok", "items": [1, 2] }
        });

        let res = result_text(&resp);
        assert!(res.ok);
        assert!(res.content.contains("\"status\":\"ok\""));
    }

    #[test]
    fn reports_error_flag_accurately() {
        let resp = json!({
            "content": [{ "type": "text", "text": "Command failed with exit code 1" }],
            "isError": true
        });

        let res = result_text(&resp);
        assert!(!res.ok);
        assert_eq!(res.content, "Command failed with exit code 1");
    }

    #[test]
    fn truncates_oversized_tool_output_with_notice() {
        let long_string = "x".repeat(70_000);
        let resp = json!({
            "content": [{ "type": "text", "text": long_string }]
        });

        let res = result_text(&resp);
        assert!(res.ok);
        assert!(
            res.content
                .contains("… output truncated (70,000 characters).")
        );
        assert!(res.content.starts_with(&"x".repeat(MAX_RESULT_CHARS)));
    }
}
