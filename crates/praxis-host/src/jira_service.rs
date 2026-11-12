//! The Jira Cloud backend (`jira/jiraService.ts`, `jiraMcpConnectionResolver.ts` and the desktop's
//! MCP OAuth provider): Jira is reached through a Model Context Protocol server, either one the
//! user runs over stdio or a remote one over streamable HTTP, authenticated with an API token
//! (`Authorization: Basic`) or an OAuth 2.1 authorization-code + PKCE loop.
//!
//! Scope of this port: connection check, projects, agile boards and their issues, search, issue
//! details, comments and transitions on both the community and the official Atlassian tool
//! surfaces. Creating, editing, deleting and attaching refuse with a message naming the gap rather
//! than guessing at Jira's field payloads.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use praxis_ai::mcp::{McpToolInfo, StdioTransport};
use praxis_contracts::{
    BackendMode, Board, BoardColumn, BoardDetails, BoardFilters, ConnectionCheck,
    ConnectionCheckStatus, CreateBoardInput, CreateIssueInput, FilterMetadata, IssueAttachment,
    IssueDetails, IssueFilters, IssueSummary, PagedIssues, ParentItemQueryOptions, Project,
    UpdateBoardInput, UpdateIssueInput, WorkflowTransition,
};
use praxis_trackers::jira::shape::{
    derive_browse_url, extract_array, normalize_comment, normalize_issue, normalize_project,
    normalize_transition,
};
use praxis_trackers::{
    IssueTrackerService, StubBackendService, TrackerResult, build_stub_backend_message,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MIN_TIMEOUT_MS: u64 = 5000;
const DEFAULT_SCOPE: &str = "read:jira-work write:jira-work read:jira-user offline_access";
const ATLASSIAN_PREFIX: &str = "mcp_com_atlassian_";

/// A Jira connection as the desktop resolves it from the connection's settings and secrets.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticJiraConfig {
    /// `stdio` or `http`.
    #[serde(default)]
    pub connection_type: String,
    #[serde(default)]
    pub stdio_command: String,
    #[serde(default)]
    pub stdio_args: Vec<String>,
    #[serde(default)]
    pub stdio_cwd: String,
    #[serde(default)]
    pub http_url: String,
    #[serde(default)]
    pub http_headers: BTreeMap<String, String>,
    /// `api-token`, `oauth` or empty.
    #[serde(default)]
    pub auth_method: String,
    #[serde(default)]
    pub api_email: String,
    #[serde(default)]
    pub api_token: String,
    #[serde(default)]
    pub oauth_client_id: String,
    #[serde(default)]
    pub oauth_client_secret: String,
    #[serde(default)]
    pub oauth_scope: String,
    #[serde(default)]
    pub oauth_issuer: String,
    #[serde(default)]
    pub oauth_authorization_endpoint: String,
    #[serde(default)]
    pub oauth_token_endpoint: String,
    /// The Jira site, for browse links.
    #[serde(default)]
    pub site_url: String,
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub default_page_size: usize,
}

impl StaticJiraConfig {
    /// A configuration names a Jira MCP server to reach (`hasJiraMcpConfig`).
    #[must_use]
    pub fn is_configured(&self) -> bool {
        // The resolver tries legacy stdio settings first, then the HTTP endpoint.
        !self.stdio_command.trim().is_empty() || !self.http_url.trim().is_empty()
    }

    fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.max(MIN_TIMEOUT_MS))
    }
}

// ── transports ───────────────────────────────────────────────────────────

fn token_cache() -> &'static Mutex<BTreeMap<String, String>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// MCP session ids by connection, so the short-lived per-call services of one connection share
/// one server-side session (a stateful server refuses a second `initialize`).
fn session_cache() -> &'static Mutex<BTreeMap<String, String>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    let _ = getrandom::getrandom(&mut buffer);
    b64url(&buffer)
}

/// Everything one MCP session over HTTP needs, including the OAuth loop on a 401.
struct HttpSession {
    config: StaticJiraConfig,
    client: reqwest::Client,
    session_id: Option<String>,
    next_id: u64,
}

fn parse_body(content_type: &str, body: &str) -> Result<Value, String> {
    if content_type.contains("text/event-stream") {
        let mut last = None;
        for event in body.split("\n\n") {
            let data: Vec<&str> = event.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim).collect();
            if !data.is_empty() {
                if let Ok(value) = serde_json::from_str::<Value>(&data.join("\n")) {
                    if value.get("result").is_some() || value.get("error").is_some() {
                        last = Some(value);
                    }
                }
            }
        }
        return last.ok_or_else(|| "The MCP server sent no response.".to_owned());
    }
    serde_json::from_str(body).map_err(|e| format!("Failed to parse the MCP response: {e}"))
}

impl HttpSession {
    fn new(config: StaticJiraConfig) -> Self {
        Self { config, client: reqwest::Client::new(), session_id: None, next_id: 1 }
    }

    fn cache_key(&self) -> String {
        format!("{}|{}|{}", self.config.connection_id, self.config.http_url, self.config.oauth_client_id)
    }

    fn authorization(&self) -> Option<String> {
        match self.config.auth_method.as_str() {
            "api-token" if !self.config.api_token.is_empty() => Some(format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", self.config.api_email, self.config.api_token))
            )),
            "oauth" => token_cache().lock().ok().and_then(|c| c.get(&self.cache_key()).map(|t| format!("Bearer {t}"))),
            _ => None,
        }
    }

    async fn post_raw(&self, body: &Value) -> Result<reqwest::Response, String> {
        let mut request = self
            .client
            .post(self.config.http_url.trim())
            .timeout(self.config.timeout())
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .json(body);
        for (name, value) in &self.config.http_headers {
            request = request.header(name, value);
        }
        if let Some(authorization) = self.authorization() {
            request = request.header("Authorization", authorization);
        }
        if let Some(session) = &self.session_id {
            request = request.header("Mcp-Session-Id", session);
        }
        request.send().await.map_err(|e| format!("HTTP request to {} failed: {e}", self.config.http_url))
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let mut response = self.post_raw(&body).await?;
        if response.status().as_u16() == 401 && self.config.auth_method == "oauth" {
            let challenge = response.headers().get("www-authenticate").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
            self.authorize(&challenge).await?;
            // The server forgot the session with the old credentials; the caller re-initialises.
            response = self.post_raw(&body).await?;
        }
        if !response.status().is_success() {
            return Err(format!("HTTP error {}: {}", response.status(), self.config.http_url));
        }
        if let Some(session) = response.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            self.session_id = Some(session.to_owned());
        }
        let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
        let text = response.text().await.map_err(|e| e.to_string())?;
        let value = parse_body(&content_type, &text)?;
        if let Some(error) = value.get("error") {
            return Err(error["message"].as_str().unwrap_or("MCP error").to_owned());
        }
        Ok(value["result"].clone())
    }

    async fn notify(&self, method: &str) {
        let _ = self.post_raw(&json!({ "jsonrpc": "2.0", "method": method })).await;
    }

    async fn initialize(&mut self) -> Result<(), String> {
        let key = self.cache_key();
        let remembered = session_cache().lock().ok().and_then(|c| c.get(&key).cloned());
        if let Some(remembered) = remembered {
            self.session_id = Some(remembered);
            // Prove the remembered session still works; otherwise start a fresh one.
            if self.request("tools/list", json!({})).await.is_ok() {
                return Ok(());
            }
            self.session_id = None;
            if let Ok(mut cache) = session_cache().lock() {
                cache.remove(&key);
            }
        }
        self.initialize_fresh().await?;
        if let (Some(id), Ok(mut cache)) = (self.session_id.clone(), session_cache().lock()) {
            cache.insert(key, id);
        }
        Ok(())
    }

    async fn initialize_fresh(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({ "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "praxis", "version": "0.1.0" } }),
        )
        .await?;
        self.notify("notifications/initialized").await;
        Ok(())
    }

    // ── OAuth 2.1: discovery, registration, PKCE authorisation, token grant ──

    async fn get_json(&self, url: &str) -> Result<Value, String> {
        let response = self.client.get(url).timeout(self.config.timeout()).send().await.map_err(|e| format!("{url}: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("{url} answered {}", response.status()));
        }
        response.json().await.map_err(|e| format!("{url}: {e}"))
    }

    async fn authorize(&mut self, challenge: &str) -> Result<(), String> {
        let origin = url::Url::parse(self.config.http_url.trim()).map_err(|e| e.to_string())?;
        let origin = format!("{}://{}", origin.scheme(), origin.host_str().map_or(String::new(), |h| origin.port().map_or(h.to_owned(), |p| format!("{h}:{p}"))));
        let resource_metadata = challenge
            .split("resource_metadata=\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .map_or_else(|| format!("{origin}/.well-known/oauth-protected-resource"), str::to_owned);
        let prm = self.get_json(&resource_metadata).await.unwrap_or(Value::Null);
        let issuer = if !self.config.oauth_issuer.is_empty() {
            self.config.oauth_issuer.clone()
        } else {
            prm["authorization_servers"][0].as_str().map_or_else(|| origin.clone(), str::to_owned)
        };
        let (authorization_endpoint, token_endpoint, registration_endpoint) = if !self.config.oauth_authorization_endpoint.is_empty() && !self.config.oauth_token_endpoint.is_empty() {
            (self.config.oauth_authorization_endpoint.clone(), self.config.oauth_token_endpoint.clone(), None)
        } else {
            let metadata = self.get_json(&format!("{}/.well-known/oauth-authorization-server", issuer.trim_end_matches('/'))).await?;
            (
                metadata["authorization_endpoint"].as_str().ok_or("The authorisation server has no authorization_endpoint.")?.to_owned(),
                metadata["token_endpoint"].as_str().ok_or("The authorisation server has no token_endpoint.")?.to_owned(),
                metadata["registration_endpoint"].as_str().map(str::to_owned),
            )
        };

        // The loopback listener the authorisation server redirects back to.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let redirect_uri = format!("http://127.0.0.1:{}/callback", listener.local_addr().map_err(|e| e.to_string())?.port());
        // As the MCP SDK resolves it: the protected resource's advertised scopes win over the
        // configured ones, which in turn win over the default.
        let advertised = prm["scopes_supported"].as_array().map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")).filter(|s| !s.is_empty());
        let scope = advertised.unwrap_or_else(|| if self.config.oauth_scope.is_empty() { DEFAULT_SCOPE.to_owned() } else { self.config.oauth_scope.clone() });

        let (client_id, client_secret) = if !self.config.oauth_client_id.is_empty() {
            (self.config.oauth_client_id.clone(), self.config.oauth_client_secret.clone())
        } else {
            let endpoint = registration_endpoint.ok_or("The server does not support dynamic client registration; configure an OAuth client id.")?;
            let response = self
                .client
                .post(&endpoint)
                .json(&json!({
                    "client_name": "Praxis", "redirect_uris": [redirect_uri], "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"], "token_endpoint_auth_method": "none", "scope": scope
                }))
                .send()
                .await
                .map_err(|e| format!("Client registration failed: {e}"))?;
            let registered: Value = response.json().await.map_err(|e| e.to_string())?;
            (registered["client_id"].as_str().ok_or("Client registration returned no client_id.")?.to_owned(), String::new())
        };

        let verifier = random_token(32);
        let challenge_code = b64url(&Sha256::digest(verifier.as_bytes()));
        let state = random_token(16);
        let mut authorize_url = url::Url::parse(&authorization_endpoint).map_err(|e| e.to_string())?;
        authorize_url
            .query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("code_challenge", &challenge_code)
            .append_pair("code_challenge_method", "S256")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("state", &state)
            .append_pair("scope", &scope)
            .append_pair("resource", self.config.http_url.trim());
        if !self.config.oauth_client_id.is_empty() {
            // The Atlassian three-legged authorisation endpoint requires these.
            authorize_url.query_pairs_mut().append_pair("audience", "api.atlassian.com").append_pair("prompt", "consent");
        }

        let waiting = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(300), listener.accept()).await.map_err(|_| "Timed out waiting for the browser sign-in.".to_owned())?.map_err(|e| e.to_string())?;
            let mut buffer = vec![0u8; 8192];
            let read = socket.read(&mut buffer).await.map_err(|e| e.to_string())?;
            let head = String::from_utf8_lossy(&buffer[..read]).to_string();
            let target = head.lines().next().unwrap_or_default().split_whitespace().nth(1).unwrap_or("/").to_owned();
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><body>Praxis is connected to Jira. You can close this tab.</body></html>").await;
            Ok::<String, String>(target)
        });

        if std::env::var("PRAXIS_E2E_NO_BROWSER").as_deref() == Ok("1") {
            // Tests replace the browser with a client that follows the redirect chain itself.
            let follower = reqwest::Client::builder().redirect(reqwest::redirect::Policy::limited(8)).build().map_err(|e| e.to_string())?;
            let _ = follower.get(authorize_url.as_str()).timeout(Duration::from_secs(15)).send().await;
        } else if std::env::var("PRAXIS_E2E").as_deref() == Ok("1") {
            return Err("Browser sign-in is unavailable in the test harness.".into());
        } else {
            let opener = if cfg!(target_os = "macos") { "open" } else if cfg!(windows) { "explorer" } else { "xdg-open" };
            let _ = std::process::Command::new(opener).arg(authorize_url.as_str()).spawn();
        }

        let target = waiting.await.map_err(|e| e.to_string())??;
        let callback = url::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|e| e.to_string())?;
        let params: BTreeMap<String, String> = callback.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        if params.get("state").map(String::as_str) != Some(state.as_str()) {
            return Err("The sign-in response did not match the request.".into());
        }
        let code = params.get("code").ok_or_else(|| params.get("error").cloned().unwrap_or_else(|| "The sign-in returned no code.".into()))?;

        let mut form = vec![
            ("grant_type", "authorization_code".to_owned()),
            ("code", code.clone()),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
        ];
        let mut request = self.client.post(&token_endpoint).timeout(self.config.timeout());
        if client_secret.is_empty() {
            form.push(("client_id", client_id));
        } else {
            request = request.header(
                "Authorization",
                format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{client_id}:{client_secret}"))),
            );
        }
        let response = request.form(&form).send().await.map_err(|e| format!("Token request failed: {e}"))?;
        let status = response.status();
        let token: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(format!("Sign-in failed: {}", token["error_description"].as_str().or(token["error"].as_str()).unwrap_or("token request refused")));
        }
        let access = token["access_token"].as_str().ok_or("The token response had no access_token.")?;
        if let Ok(mut cache) = token_cache().lock() {
            cache.insert(self.cache_key(), access.to_owned());
        }
        self.session_id = None;
        Ok(())
    }
}

enum Session {
    Stdio(Box<StdioTransport>),
    Http(Box<HttpSession>),
}

fn text_to_value(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned()))
}

// ── the service ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Adapter {
    Community,
    Atlassian,
}

struct Connected {
    session: Session,
    adapter: Adapter,
    names: Vec<String>,
    cloud_id: Option<String>,
}

macro_rules! with_conn {
    ($service:expr, |$c:ident| $body:block) => {{
        let mut guard = $service.guard().await?;
        let $c: &mut Connected = guard.as_mut().ok_or("Jira MCP connection has not been established.")?;
        async { $body }.await
    }};
}

/// Jira over MCP. A service reaches its server lazily and keeps the session until reset.
pub struct JiraCloudService {
    config: StaticJiraConfig,
    state: tokio::sync::Mutex<Option<Connected>>,
}

impl JiraCloudService {
    #[must_use]
    pub fn new(config: StaticJiraConfig) -> Self {
        Self { config, state: tokio::sync::Mutex::new(None) }
    }

    async fn connect(&self) -> Result<Connected, String> {
        if !self.config.is_configured() {
            return Err(build_stub_backend_message(BackendMode::Jiracloud));
        }
        let use_stdio = !self.config.stdio_command.trim().is_empty();
        let (mut session, tools) = if use_stdio {
            use praxis_ai::mcp::McpTransportConnection;
            let mut transport = StdioTransport::spawn_in(self.config.stdio_command.trim(), &self.config.stdio_args, &None, Some(self.config.stdio_cwd.trim())).await?;
            tokio::time::timeout(self.config.timeout(), transport.initialize()).await.map_err(|_| "Timed out connecting to the Jira MCP server.".to_owned())??;
            let tools: Vec<McpToolInfo> = transport.list_tools().await?;
            (Session::Stdio(Box::new(transport)), tools.into_iter().map(|t| t.name).collect::<Vec<_>>())
        } else {
            let mut http = HttpSession::new(self.config.clone());
            http.initialize().await?;
            let listed = http.request("tools/list", json!({})).await?;
            let names = listed["tools"].as_array().map(|tools| tools.iter().filter_map(|t| t["name"].as_str().map(str::to_owned)).collect()).unwrap_or_default();
            (Session::Http(Box::new(http)), names)
        };
        let community = tools.iter().any(|n| n.starts_with("atlassian-jira_"));
        let atlassian = tools.iter().any(|n| n.contains("atlassian") && !n.starts_with("atlassian-jira_")) || tools.iter().any(|n| n == "getAccessibleAtlassianResources");
        let adapter = if community || !atlassian { Adapter::Community } else { Adapter::Atlassian };
        if let (Adapter::Community, false) = (adapter, community) {
            // Nothing recognisable: still treat as community so the error names a missing tool.
            let _ = &mut session;
        }
        Ok(Connected { session, adapter, names: tools, cloud_id: None })
    }

    async fn guard(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Connected>>, String> {
        let mut guard = self.state.lock().await;
        if guard.is_none() {
            *guard = Some(self.connect().await?);
        }
        Ok(guard)
    }

    fn site(&self) -> String {
        self.config.site_url.trim().trim_end_matches('/').to_owned()
    }
}

fn resolve_tool(names: &[String], canonical: &str) -> Option<String> {
    let mut candidates = vec![canonical.to_owned()];
    if let Some(bare) = canonical.strip_prefix(ATLASSIAN_PREFIX) {
        candidates.push(bare.to_owned());
        if bare == "updateJiraIssue" {
            candidates.push("editJiraIssue".to_owned());
        }
    }
    candidates.into_iter().find(|c| names.iter().any(|n| n == c))
}

async fn call_json(connected: &mut Connected, timeout: Duration, name: &str, arguments: Value) -> Result<Value, String> {
    match &mut connected.session {
        Session::Stdio(transport) => {
            use praxis_ai::mcp::McpTransportConnection;
            let result = tokio::time::timeout(timeout, transport.call_tool(name, &arguments)).await.map_err(|_| format!("Timed out calling {name}."))??;
            if !result.ok {
                return Err(result.content);
            }
            Ok(text_to_value(&result.content))
        }
        Session::Http(http) => {
            let result = http.request("tools/call", json!({ "name": name, "arguments": arguments })).await?;
            let flattened = praxis_ai::mcp::result_text(&result);
            if !flattened.ok {
                return Err(flattened.content);
            }
            Ok(text_to_value(&flattened.content))
        }
    }
}

async fn resolve_cloud_id(connected: &mut Connected, timeout: Duration) -> Result<String, String> {
    if let Some(id) = &connected.cloud_id {
        return Ok(id.clone());
    }
    let tool = resolve_tool(&connected.names, &format!("{ATLASSIAN_PREFIX}getAccessibleAtlassianResources")).ok_or("The Atlassian MCP exposes no accessible-resources tool.")?;
    let resources = call_json(connected, timeout, &tool, json!({})).await?;
    let id = extract_array(&resources, &["resources"])
        .first()
        .or_else(|| resources.as_array().and_then(|a| a.first()))
        .and_then(|r| r["id"].as_str())
        .map(str::to_owned)
        .ok_or("The Atlassian MCP cloudId has not been resolved. Re-run \"Connect with Atlassian\" to choose a Jira site.")?;
    connected.cloud_id = Some(id.clone());
    Ok(id)
}

const ISSUE_FIELDS: [&str; 9] = ["summary", "status", "issuetype", "assignee", "priority", "updated", "project", "description", "parent"];

fn normalize_board(raw: &Value) -> Option<Board> {
    let id = crate::jira_value(raw, "id")?;
    let name = crate::jira_value(raw, "name")?;
    let location = raw.get("location").filter(|l| l.is_object());
    let creator = ["creator", "createdBy", "owner"].iter().find_map(|k| raw.get(k).filter(|v| v.is_object()));
    let s = |value: Option<&Value>, key: &str| value.and_then(|v| crate::jira_value(v, key));
    let mut board = json!({
        "id": id, "name": name, "type": crate::jira_value(raw, "type").unwrap_or_else(|| "scrum".into()),
        "raw": raw
    });
    let project_key = location.map_or_else(|| crate::jira_value(raw, "projectKey"), |l| crate::jira_value(l, "projectKey"));
    let project_name = location.map_or_else(|| crate::jira_value(raw, "projectName"), |l| crate::jira_value(l, "projectName").or_else(|| crate::jira_value(raw, "projectName")));
    for (key, value) in [
        ("createdBy", creator.and_then(|c| crate::jira_value(c, "displayName").or_else(|| crate::jira_value(c, "name")).or_else(|| crate::jira_value(c, "username")))),
        ("createdAt", crate::jira_value(raw, "createdAt").or_else(|| crate::jira_value(raw, "created"))),
        ("projectKey", project_key),
        ("projectName", project_name),
        ("locationName", s(location, "name")),
    ] {
        if let Some(value) = value {
            board[key] = json!(value);
        }
    }
    serde_json::from_value(board).ok()
}

fn columns_for(issues: &[IssueSummary]) -> Vec<BoardColumn> {
    let mut columns: Vec<BoardColumn> = Vec::new();
    for issue in issues {
        match columns.iter_mut().find(|c| c.name == issue.status) {
            Some(column) => column.issues.push(issue.clone()),
            None => columns.push(BoardColumn {
                id: issue.status.clone(),
                name: issue.status.clone(),
                status_category: issue.status_category.clone(),
                issues: vec![issue.clone()],
            }),
        }
    }
    columns
}

fn sort_by_updated(issues: &mut [IssueSummary]) {
    issues.sort_by(|a, b| b.updated.clone().unwrap_or_default().cmp(&a.updated.clone().unwrap_or_default()).then_with(|| a.key.cmp(&b.key)));
}

fn escape_jql_value(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn build_jql(filters: &IssueFilters) -> String {
    let mut clauses: Vec<String> = Vec::new();
    if !filters.project_keys.is_empty() {
        clauses.push(format!("project in ({})", filters.project_keys.iter().map(|k| escape_jql_value(k)).collect::<Vec<_>>().join(", ")));
    }
    if !filters.statuses.is_empty() {
        clauses.push(format!("status in ({})", filters.statuses.iter().map(|k| escape_jql_value(k)).collect::<Vec<_>>().join(", ")));
    }
    if !filters.issue_types.is_empty() {
        clauses.push(format!("issuetype in ({})", filters.issue_types.iter().map(|k| escape_jql_value(k)).collect::<Vec<_>>().join(", ")));
    }
    if let Some(parent) = filters.parent_key.as_deref().filter(|p| !p.trim().is_empty()) {
        clauses.push(format!("parent = {}", escape_jql_value(parent.trim())));
    }
    let text = filters.search_text.trim();
    if !text.is_empty() {
        clauses.push(format!("text ~ {}", escape_jql_value(&text.replace('\\', "\\\\").replace('"', "\\\""))));
    }
    let order = "ORDER BY updated DESC";
    if clauses.is_empty() { order.to_owned() } else { format!("{} {order}", clauses.join(" AND ")) }
}

impl JiraCloudService {
    async fn search(&self, jql: &str, start_at: usize, max: usize) -> Result<(Vec<IssueSummary>, usize), String> {
        let timeout = self.config.timeout();
        let base = self.site();
        with_conn!(self, |c| {
            let args = if c.adapter == Adapter::Atlassian {
                json!({ "cloudId": resolve_cloud_id(c, timeout).await?, "jql": jql, "maxResults": max, "fields": ISSUE_FIELDS })
            } else {
                json!({ "jql": jql, "limit": max, "start_at": start_at, "fields": ISSUE_FIELDS.join(",") })
            };
            let tool = if c.adapter == Adapter::Atlassian {
                resolve_tool(&c.names, &format!("{ATLASSIAN_PREFIX}searchJiraIssuesUsingJql")).ok_or("The Atlassian MCP exposes no search tool.")?
            } else {
                "atlassian-jira_search".to_owned()
            };
            let payload = call_json(c, timeout, &tool, args).await?;
            let issues: Vec<IssueSummary> = extract_array(&payload, &["issues"]).iter().filter_map(|raw| normalize_issue(raw, &base)).collect();
            let mut total = payload["total"].as_u64().map_or(start_at + issues.len(), |t| t as usize);
            if total < start_at + issues.len() {
                total = start_at + issues.len() + usize::from(payload["nextPageToken"].is_string());
            }
            Ok((issues, total))
        })
    }

    async fn agile_boards(&self) -> Result<Vec<Board>, String> {
        let timeout = self.config.timeout();
        with_conn!(self, |c| {
            if c.adapter != Adapter::Community || !c.names.iter().any(|n| n == "atlassian-jira_get_agile_boards") {
                return Ok(Vec::new());
            }
            let payload = call_json(c, timeout, "atlassian-jira_get_agile_boards", json!({ "limit": 100, "start_at": 0 })).await?;
            Ok(extract_array(&payload, &["values", "boards"]).iter().filter_map(normalize_board).collect())
        })
    }

    async fn agile_board_issues(&self, board_id: &str) -> Result<Vec<IssueSummary>, String> {
        let timeout = self.config.timeout();
        let base = self.site();
        with_conn!(self, |c| {
            if c.adapter != Adapter::Community {
                return Ok(Vec::new());
            }
            let payload = call_json(c, timeout, "atlassian-jira_get_board_issues", json!({ "board_id": board_id, "jql": "ORDER BY updated DESC", "limit": 100, "start_at": 0 })).await?;
            Ok(extract_array(&payload, &["issues"]).iter().filter_map(|raw| normalize_issue(raw, &base)).collect())
        })
    }

    fn agile_board_id(board: &Board) -> Option<String> {
        if let Some(raw) = board.raw.as_ref().filter(|r| r.is_object()) {
            if let Some(id) = crate::jira_value(raw, "agileBoardId").or_else(|| crate::jira_value(raw, "id")) {
                return Some(id);
            }
        }
        (!board.id.starts_with("epic:") && board.id != "jql:workspace" && !board.id.starts_with("jql:custom:")).then(|| board.id.clone())
    }

    fn unsupported<T>(&self, what: &str) -> TrackerResult<T> {
        Err(format!("{what} is not supported by the Jira desktop backend yet."))
    }
}

#[async_trait]
impl IssueTrackerService for JiraCloudService {
    fn mode(&self) -> BackendMode {
        BackendMode::Jiracloud
    }

    fn get_default_page_size(&self) -> usize {
        if self.config.default_page_size == 0 { 25 } else { self.config.default_page_size }
    }

    async fn reset(&self) -> TrackerResult<()> {
        let mut guard = self.state.lock().await;
        if let Some(Connected { session: Session::Stdio(mut transport), .. }) = guard.take() {
            use praxis_ai::mcp::McpTransportConnection;
            let _ = transport.close().await;
        }
        Ok(())
    }

    async fn check_connection(&self) -> TrackerResult<ConnectionCheck> {
        if !self.config.is_configured() {
            return Ok(ConnectionCheck {
                status: ConnectionCheckStatus::Error,
                message: build_stub_backend_message(BackendMode::Jiracloud),
                tool_count: 0,
                project_count: None,
                server_name: None,
            });
        }
        match self.get_projects(true).await {
            Ok(projects) => {
                let tool_count = self.state.lock().await.as_ref().map_or(0, |c| c.names.len() as u32);
                let count = projects.len() as u32;
                Ok(if count == 0 {
                    ConnectionCheck { status: ConnectionCheckStatus::Warning, message: "Connected, but no Jira projects are accessible.".into(), tool_count, project_count: Some(0), server_name: None }
                } else {
                    ConnectionCheck { status: ConnectionCheckStatus::Ok, message: format!("Connected. {count} accessible project(s) found."), tool_count, project_count: Some(count), server_name: None }
                })
            }
            Err(message) => Ok(ConnectionCheck { status: ConnectionCheckStatus::Error, message, tool_count: 0, project_count: None, server_name: None }),
        }
    }

    async fn get_projects(&self, _force_refresh: bool) -> TrackerResult<Vec<Project>> {
        let timeout = self.config.timeout();
        let mut projects = with_conn!(self, |c| {
                let payload = if c.adapter == Adapter::Atlassian {
                    let tool = resolve_tool(&c.names, &format!("{ATLASSIAN_PREFIX}getVisibleJiraProjects")).ok_or("The Atlassian MCP exposes no project tool.")?;
                    let cloud = resolve_cloud_id(c, timeout).await?;
                    call_json(c, timeout, &tool, json!({ "cloudId": cloud, "maxResults": 100 })).await?
                } else {
                    call_json(c, timeout, "atlassian-jira_get_all_projects", json!({})).await?
                };
                Ok::<Vec<Project>, String>(extract_array(&payload, &["values", "projects"]).iter().filter_map(normalize_project).collect())
            })?;
        projects.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(projects)
    }

    async fn get_issues(&self, filters: &IssueFilters, start_at: usize, page_size: usize) -> TrackerResult<PagedIssues> {
        if let Some(board_id) = filters.board_id.as_deref().filter(|id| !id.starts_with("epic:") && *id != "jql:workspace" && !id.starts_with("jql:custom:")) {
            let community = self.state.lock().await.as_ref().map_or(true, |c| c.adapter == Adapter::Community);
            if community {
                let mut issues = self.agile_board_issues(board_id).await?;
                issues.retain(|issue| (filters.statuses.is_empty() || filters.statuses.contains(&issue.status)) && (filters.issue_types.is_empty() || filters.issue_types.contains(&issue.issue_type)) && (filters.project_keys.is_empty() || filters.project_keys.contains(&issue.project_key)));
                sort_by_updated(&mut issues);
                let total = issues.len();
                let page: Vec<IssueSummary> = issues.into_iter().skip(start_at).take(page_size).collect();
                return Ok(PagedIssues { issues: page, total: Some(total as u32), has_more: start_at + page_size < total });
            }
        }
        let (issues, total) = self.search(&build_jql(filters), start_at, page_size).await?;
        Ok(PagedIssues { has_more: start_at + issues.len() < total, total: Some(total as u32), issues })
    }

    async fn get_filter_metadata(&self, filters: &IssueFilters) -> TrackerResult<FilterMetadata> {
        let scoped = IssueFilters { statuses: Vec::new(), issue_types: Vec::new(), search_text: String::new(), parent_key: None, ..filters.clone() };
        let (issues, _) = self.search(&build_jql(&scoped), 0, 200).await?;
        let mut statuses: Vec<String> = issues.iter().map(|i| i.status.clone()).collect();
        let mut types: Vec<String> = issues.iter().map(|i| i.issue_type.clone()).collect();
        statuses.sort();
        statuses.dedup();
        types.sort();
        types.dedup();
        Ok(FilterMetadata { statuses, issue_types: types, ..FilterMetadata::default() })
    }

    async fn get_parent_items(&self, filters: &IssueFilters, search_text: Option<&str>, _options: Option<&ParentItemQueryOptions>) -> TrackerResult<Vec<IssueSummary>> {
        let mut clauses = vec!["issuetype in (\"Epic\")".to_owned()];
        if !filters.project_keys.is_empty() {
            clauses.push(format!("project in ({})", filters.project_keys.iter().map(|k| escape_jql_value(k)).collect::<Vec<_>>().join(", ")));
        }
        if let Some(text) = search_text.map(str::trim).filter(|t| !t.is_empty()) {
            clauses.push(format!("text ~ {}", escape_jql_value(text)));
        }
        let (mut issues, _) = self.search(&format!("{} ORDER BY updated DESC", clauses.join(" AND ")), 0, 50).await?;
        sort_by_updated(&mut issues);
        Ok(issues)
    }

    async fn supports_boards(&self) -> TrackerResult<bool> {
        with_conn!(self, |c| { Ok(c.adapter == Adapter::Community && c.names.iter().any(|n| n == "atlassian-jira_get_agile_boards")) })
    }

    async fn get_boards(&self, filters: &BoardFilters) -> TrackerResult<Vec<Board>> {
        let boards = self.agile_boards().await?;
        let needle = filters.search_text.trim().to_lowercase();
        Ok(boards
            .into_iter()
            .filter(|board| {
                (filters.types.is_empty() || filters.types.contains(&board.board_type))
                    && (filters.project_keys.is_empty() || board.project_key.as_deref().is_some_and(|k| filters.project_keys.iter().any(|f| f == k.trim())))
                    && (needle.is_empty() || format!("{} {}", board.name, board.project_name.clone().unwrap_or_default()).to_lowercase().contains(&needle))
            })
            .collect())
    }

    async fn get_board_details(&self, board: &Board) -> TrackerResult<BoardDetails> {
        let Some(id) = Self::agile_board_id(board) else {
            return self.unsupported("Epic and JQL boards");
        };
        let mut issues = self.agile_board_issues(&id).await?;
        sort_by_updated(&mut issues);
        Ok(BoardDetails { board: board.clone(), columns: columns_for(&issues), issues, column_status_order: None })
    }

    async fn create_board(&self, _input: &CreateBoardInput) -> TrackerResult<Board> {
        Err("Creating boards is not supported in Jira MCP mode. Boards are derived from the linked epic or configured JQL query.".into())
    }

    async fn update_board(&self, _board_id: &str, _input: &UpdateBoardInput) -> TrackerResult<Board> {
        self.unsupported("Renaming Jira boards")
    }

    async fn delete_board(&self, _board_id: &str) -> TrackerResult<()> {
        self.unsupported("Removing Jira boards")
    }

    async fn get_issue(&self, issue_key: &str) -> TrackerResult<IssueDetails> {
        let timeout = self.config.timeout();
        let base = self.site();
        let fields: Vec<&str> = vec!["summary", "status", "issuetype", "assignee", "priority", "created", "updated", "project", "description", "parent", "comment", "attachment", "issuelinks"];
        let response = with_conn!(self, |c| {
                if c.adapter == Adapter::Atlassian {
                    let tool = resolve_tool(&c.names, &format!("{ATLASSIAN_PREFIX}getJiraIssue")).ok_or("The Atlassian MCP exposes no issue tool.")?;
                    let cloud = resolve_cloud_id(c, timeout).await?;
                    call_json(c, timeout, &tool, json!({ "cloudId": cloud, "issueIdOrKey": issue_key, "fields": fields })).await
                } else {
                    call_json(c, timeout, "atlassian-jira_get_issue", json!({ "issue_key": issue_key, "fields": fields.join(",") })).await
                }
            })?;
        let summary = normalize_issue(&response, &base).ok_or_else(|| format!("Unable to load details for {issue_key}."))?;
        let comments = response["fields"]["comment"]["comments"].as_array().map(|items| items.iter().filter_map(normalize_comment).collect::<Vec<_>>());
        let mut transitions = self.get_transitions(issue_key).await.unwrap_or_default();
        transitions.retain(|t| !t.id.is_empty());
        Ok(IssueDetails { summary, transitions: Some(transitions), comments, linked_issues: None })
    }

    async fn create_issue(&self, _input: &CreateIssueInput) -> TrackerResult<IssueDetails> {
        self.unsupported("Creating Jira issues")
    }

    async fn update_issue(&self, _issue_key: &str, _input: &UpdateIssueInput) -> TrackerResult<IssueDetails> {
        self.unsupported("Editing Jira issues")
    }

    async fn delete_issue(&self, _issue_key: &str) -> TrackerResult<()> {
        self.unsupported("Deleting Jira issues")
    }

    async fn add_comment(&self, issue_key: &str, body: &str) -> TrackerResult<()> {
        let timeout = self.config.timeout();
        with_conn!(self, |c| {
            if c.adapter == Adapter::Atlassian {
                let tool = resolve_tool(&c.names, &format!("{ATLASSIAN_PREFIX}addCommentToJiraIssue")).ok_or("The Atlassian MCP exposes no comment tool.")?;
                let cloud = resolve_cloud_id(c, timeout).await?;
                call_json(c, timeout, &tool, json!({ "cloudId": cloud, "issueIdOrKey": issue_key, "commentBody": body })).await?;
            } else {
                call_json(c, timeout, "atlassian-jira_add_comment", json!({ "issue_key": issue_key, "comment": body })).await?;
            }
            Ok(())
        })
    }

    async fn attach_file(&self, _issue_key: &str, _file_path: &str, _file_name: Option<&str>) -> TrackerResult<()> {
        self.unsupported("Attaching files to Jira issues")
    }

    async fn download_attachment(&self, _issue_key: &str, _attachment: &IssueAttachment, _target_file_path: &str) -> TrackerResult<()> {
        self.unsupported("Downloading Jira attachments")
    }

    async fn get_transitions(&self, issue_key: &str) -> TrackerResult<Vec<WorkflowTransition>> {
        let timeout = self.config.timeout();
        with_conn!(self, |c| {
            let payload = if c.adapter == Adapter::Atlassian {
                let tool = resolve_tool(&c.names, &format!("{ATLASSIAN_PREFIX}getTransitionsForJiraIssue")).ok_or("The Atlassian MCP exposes no transitions tool.")?;
                let cloud = resolve_cloud_id(c, timeout).await?;
                call_json(c, timeout, &tool, json!({ "cloudId": cloud, "issueIdOrKey": issue_key })).await?
            } else {
                call_json(c, timeout, "atlassian-jira_get_transitions", json!({ "issue_key": issue_key })).await?
            };
            Ok(extract_array(&payload, &["transitions"]).iter().filter_map(normalize_transition).collect())
        })
    }

    async fn transition_issue(&self, issue_key: &str, transition_id: &str) -> TrackerResult<()> {
        let timeout = self.config.timeout();
        with_conn!(self, |c| {
            if c.adapter != Adapter::Community {
                return Err("Transitions are not available on the Atlassian MCP surface.".to_owned());
            }
            call_json(c, timeout, "atlassian-jira_transition_issue", json!({ "issue_key": issue_key, "transition_id": transition_id })).await?;
            Ok(())
        })
    }

    async fn get_browse_url(&self, issue: &IssueSummary) -> TrackerResult<Option<String>> {
        let base = self.site();
        Ok((!base.is_empty()).then(|| derive_browse_url(&base, &issue.key)))
    }

    async fn get_self_assignee_label(&self) -> TrackerResult<Option<String>> {
        Ok(self.search("assignee = currentUser() ORDER BY updated DESC", 0, 1).await.ok().and_then(|(issues, _)| issues.into_iter().next().and_then(|i| i.assignee)))
    }

    fn dispose(&self) {}
}

/// The refusal a connection with no endpoint gets, for the registry's `default` arm.
#[must_use]
pub fn unconfigured() -> Arc<dyn IssueTrackerService> {
    Arc::new(StubBackendService::new(BackendMode::Jiracloud))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_config() -> Option<StaticJiraConfig> {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/praxis-desktop/e2e/mockJiraMcpServer.mjs");
        let node = std::process::Command::new("node").arg("--version").output().ok()?;
        node.status.success().then(|| StaticJiraConfig {
            connection_type: "stdio".into(),
            stdio_command: "node".into(),
            stdio_args: vec![script.to_string_lossy().into_owned()],
            timeout_ms: 10_000,
            ..StaticJiraConfig::default()
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checks_connection_and_lists_boards_against_the_mock_server() {
        let Some(config) = mock_config() else { return };
        let service = JiraCloudService::new(config);
        let check = service.check_connection().await.expect("check");
        assert_eq!(check.status, ConnectionCheckStatus::Ok, "{}", check.message);
        let boards = service.get_boards(&BoardFilters::default()).await.expect("boards");
        assert_eq!(boards[0].name, "Demo Board");
        let details = service.get_board_details(&boards[0]).await.expect("details");
        assert!(!details.issues.is_empty());
        let issue = service.get_issue(&details.issues[0].key).await.expect("issue");
        assert!(issue.transitions.is_some());
    }
}
