//! The in-app browser for ACP agents (`browserMcp.ts` + `browserMcpServer.ts` port): a loopback
//! HTTP MCP server whose `browser_*` tools drive the same browser the gateway path uses.
//!
//! One endpoint per session, living for the whole session (a follow-up turn reuses the same URL
//! and token so the agent's MCP connection never drops). Navigation to a host that is not on the
//! allow-list — by the tool itself, a link it clicks, a form it submits or a redirect — is raised
//! on that session's permission card, and an approval is remembered.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, PoisonError};

use praxis_host::HostContext;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::{acp_host, ai_browser};

#[derive(Clone)]
struct Registration {
    key: String,
    dir: PathBuf,
    host: HostContext,
}

struct Server {
    port: u16,
    sessions: Mutex<BTreeMap<String, Registration>>,
}

fn server(host: &HostContext) -> Option<&'static Server> {
    static SERVER: OnceLock<Option<Server>> = OnceLock::new();
    let _ = host;
    let server = SERVER
        .get_or_init(|| {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
            listener.set_nonblocking(true).ok()?;
            let port = listener.local_addr().ok()?.port();
            super::runtime::runtime().spawn(async move {
                let Ok(listener) = TcpListener::from_std(listener) else {
                    return;
                };
                while let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(serve(stream));
                }
            });
            Some(Server {
                port,
                sessions: Mutex::new(BTreeMap::new()),
            })
        })
        .as_ref();
    if let Some(server) = server {
        let _ = SERVER_REF.set(server);
    }
    server
}

fn token_for(
    registrations: &BTreeMap<String, Registration>,
    dir: &std::path::Path,
    key: &str,
) -> Option<String> {
    registrations
        .iter()
        .find(|(_, r)| r.key == key && r.dir == dir)
        .map(|(token, _)| token.clone())
}

/// The ACP `mcpServers` entry that gives `key`'s session the in-app browser, or `None` when the
/// feature is off or the session is not full-tools.
pub fn server_for_session(
    host: &HostContext,
    dir: &std::path::Path,
    key: &str,
    tool_mode: &str,
) -> Option<Value> {
    if tool_mode != "full" || !host.settings().read().ai.browser_tools.enabled {
        return None;
    }
    let server = server(host)?;
    let mut sessions = server
        .sessions
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let token = token_for(&sessions, dir, key).unwrap_or_else(|| {
        let token = uuid::Uuid::new_v4().simple().to_string();
        sessions.insert(
            token.clone(),
            Registration {
                key: key.to_owned(),
                dir: dir.to_path_buf(),
                host: host.clone(),
            },
        );
        token
    });
    Some(json!({
        "name": "praxis-browser",
        "url": format!("http://127.0.0.1:{}/mcp", server.port),
        "headers": { "authorization": format!("Bearer {token}") }
    }))
}

/// Tears a session's endpoint down (when the session is deleted).
#[allow(dead_code)]
pub fn dispose_for_session(host: &HostContext, dir: &std::path::Path, key: &str) {
    if let Some(server) = server(host) {
        let mut sessions = server
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(token) = token_for(&sessions, dir, key) {
            sessions.remove(&token);
        }
    }
}

/// The largest JSON-RPC body accepted. Browser tool calls are a URL or a few words of text.
const MAX_BODY: usize = 1_000_000;

async fn read_request(
    stream: &mut TcpStream,
) -> Option<(String, BTreeMap<String, String>, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break position;
        }
        if buffer.len() > 1_000_000 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next()?.to_owned();
    let headers: BTreeMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_owned()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    // The body is read before the bearer token is checked, so its size is bounded here: any local
    // process (or a web page posting to loopback) could otherwise make the host buffer gigabytes.
    if length > MAX_BODY {
        return None;
    }
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Some((request_line, headers, body))
}

async fn respond(stream: &mut TcpStream, status: &str, extra: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn serve(mut stream: TcpStream) {
    let Some((request_line, headers, body)) = read_request(&mut stream).await else {
        return;
    };
    let registration = {
        let token = headers
            .get("authorization")
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        let Some(server) = lookup(&token) else {
            respond(
                &mut stream,
                "401 Unauthorized",
                "",
                r#"{"error":"unauthorized"}"#,
            )
            .await;
            return;
        };
        server
    };
    if request_line.starts_with("DELETE") {
        respond(&mut stream, "200 OK", "", "{}").await;
        return;
    }
    if !request_line.starts_with("POST") {
        respond(
            &mut stream,
            "405 Method Not Allowed",
            "",
            r#"{"error":"method not allowed"}"#,
        )
        .await;
        return;
    }
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        respond(
            &mut stream,
            "400 Bad Request",
            "",
            r#"{"error":"bad json"}"#,
        )
        .await;
        return;
    };
    let Some(id) = message.get("id").cloned() else {
        // A notification: acknowledged, no body.
        respond(&mut stream, "202 Accepted", "", "").await;
        return;
    };
    let result = match message["method"].as_str().unwrap_or_default() {
        "initialize" => json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "praxis-browser", "version": "1.0.0" }
        }),
        "ping" => json!({}),
        "tools/list" => json!({
            "tools": ai_browser::tool_definitions().into_iter().map(|(name, description, schema)| json!({ "name": name, "description": description, "inputSchema": schema })).collect::<Vec<_>>()
        }),
        "tools/call" => call_tool(&registration, &message["params"]).await,
        other => {
            let error = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {other}") } });
            respond(&mut stream, "200 OK", "", &error.to_string()).await;
            return;
        }
    };
    let session = if message["method"] == "initialize" {
        "Mcp-Session-Id: praxis-browser\r\n"
    } else {
        ""
    };
    respond(
        &mut stream,
        "200 OK",
        session,
        &json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string(),
    )
    .await;
}

fn lookup(token: &str) -> Option<Registration> {
    let server = SERVER_REF.get()?;
    server
        .sessions
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(token)
        .cloned()
}

static SERVER_REF: OnceLock<&'static Server> = OnceLock::new();

fn tool_result(ok: bool, text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": !ok })
}

async fn call_tool(registration: &Registration, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or_default().to_owned();
    let arguments = params["arguments"].clone();
    let host = &registration.host;
    let task = acp_host::find_task_public(&registration.dir, &registration.key);
    if !host.settings().read().ai.browser_tools.enabled {
        return tool_result(
            false,
            "The in-app browser is turned off in Settings.".into(),
        );
    }
    // The browser is held for the session's whole sequence of calls; a person using it, or another session, refuses it.
    if let Err(reason) = super::coordination::hold_browser_for_sequence(&registration.key).await {
        return tool_result(false, reason);
    }
    let approver: super::browser_policy::Approver = {
        let task = task.clone();
        let tool = name.clone();
        std::sync::Arc::new(move |host_name: String, url: String| {
            let task = task.clone();
            let request = json!({ "toolCallId": format!("browser-{}", uuid::Uuid::new_v4().simple()), "kind": "browser-navigate", "title": format!("Open {host_name} in the in-app browser"), "name": tool, "rawInput": { "url": url } });
            Box::pin(async move {
                match task {
                    Some(task) => {
                        task.request_permission(request).await != acp_host::Decision::Deny
                    }
                    None => false,
                }
            })
        })
    };
    let (ok, text) = ai_browser::run_tool(host, &name, &arguments, &approver).await;
    if let Some(task) = &task {
        task.append(
            acp_host::evt(
                "tool_complete",
                format!("Tool {}: {name}", if ok { "completed" } else { "failed" }),
                Some(text.chars().take(2000).collect()),
                Some(json!({ "toolName": name, "ok": ok, "kind": "fetch" })),
            ),
            1,
        );
    }
    tool_result(ok, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn request_over_loopback(raw: Vec<u8>) -> Option<(String, Vec<u8>)> {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            let _ = stream.write_all(&raw).await;
            stream
        });
        let (mut stream, _) = listener.accept().await.expect("accept");
        let read = read_request(&mut stream).await;
        drop(client.await);
        read.map(|(line, _, body)| (line, body))
    }

    #[tokio::test]
    async fn an_oversized_body_is_refused_before_it_is_buffered() {
        // Pre-auth: no token is needed to declare a length, so the declared length is capped.
        let raw = format!(
            "POST /mcp HTTP/1.1\r\nContent-Length: {}\r\n\r\n{{}}",
            MAX_BODY + 1
        );
        assert!(request_over_loopback(raw.into_bytes()).await.is_none());
    }

    #[tokio::test]
    async fn an_ordinary_request_is_read_whole() {
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let raw = format!(
            "POST /mcp HTTP/1.1\r\nAuthorization: Bearer x\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let (line, read) = request_over_loopback(raw.into_bytes())
            .await
            .expect("request");
        assert!(line.starts_with("POST /mcp"));
        assert_eq!(read, body.as_bytes());
    }
}
