//! The MCP servers the user added (Settings > AI Provider > Tools), put in front of their CLI
//! agents at session start (`userMcp.ts`'s `userMcpAcpServers`). The agent connects to them
//! itself over ACP. Full-tools sessions only: a user-added server can do whatever its tools
//! allow, so a read-only session never gets it.

use praxis_core::config::mcp_servers::{
    McpServerConfig, McpTransport, enabled_mcp_servers, mcp_server_slug,
};
use praxis_host::HostContext;
use serde_json::{Value, json};

/// Explicit egress consent follows the destination provider, including after handover.
fn applies_to_provider(server: &McpServerConfig, provider: &str) -> bool {
    if let Some(destination) = server
        .env
        .as_ref()
        .and_then(|env| env.get("PRAXIS_CODE_INTELLIGENCE_PROVIDER"))
        .filter(|d| !d.is_empty())
    {
        return provider == destination;
    }
    let bridge = |arg: &String| {
        arg.ends_with("codeIntelligence/mcpBridge.js")
            || arg.ends_with("codeIntelligence\\mcpBridge.js")
    };
    !(server.id.starts_with("praxis-code-intelligence-")
        || server
            .args
            .as_ref()
            .is_some_and(|args| args.iter().any(bridge)))
}

fn active_servers(host: &HostContext, tool_mode: &str, provider: &str) -> Vec<McpServerConfig> {
    if tool_mode != "full" {
        return Vec::new();
    }
    let configured = host
        .settings()
        .read()
        .ai
        .mcp_servers
        .clone()
        .unwrap_or_default();
    enabled_mcp_servers(&configured)
        .into_iter()
        .filter(|server| applies_to_provider(server, provider))
        .collect()
}

/// The `mcpServers` entries for an ACP session (`{ name, url, headers }` or `{ name, command, args, env }`).
pub(super) fn acp_servers(host: &HostContext, tool_mode: &str, provider: &str) -> Vec<Value> {
    active_servers(host, tool_mode, provider)
        .into_iter()
        .map(|server| {
            let name = mcp_server_slug(&server.name);
            match server.transport {
                McpTransport::Http => json!({ "name": name, "url": server.url.unwrap_or_default(), "headers": server.headers }),
                McpTransport::Stdio => json!({ "name": name, "command": server.command.unwrap_or_default(), "args": server.args, "env": server.env }),
            }
        })
        .collect()
}

// ── API-provider sessions and the settings "Test" button ─────────────────

fn pool() -> &'static praxis_ai::mcp::tool_bridge::McpClientPool {
    static POOL: std::sync::OnceLock<praxis_ai::mcp::tool_bridge::McpClientPool> =
        std::sync::OnceLock::new();
    POOL.get_or_init(praxis_ai::mcp::tool_bridge::McpClientPool::new)
}

/// The user's servers' tools for an API session (they have no MCP client, so the tools are
/// bridged into the ordinary tool list), with the servers that own them. Servers that cannot be
/// reached are skipped for the session.
pub(super) async fn api_tools(
    host: &HostContext,
    tool_mode: &str,
    provider: &str,
) -> (
    Vec<McpServerConfig>,
    Vec<praxis_ai::mcp::tool_bridge::ResolvedMcpTool>,
) {
    let servers = active_servers(host, tool_mode, provider);
    // A server the user removed or switched off should not keep a process alive.
    let keep: std::collections::HashSet<String> = enabled_mcp_servers(
        &host
            .settings()
            .read()
            .ai
            .mcp_servers
            .clone()
            .unwrap_or_default(),
    )
    .into_iter()
    .map(|s| s.id)
    .collect();
    for server in host
        .settings()
        .read()
        .ai
        .mcp_servers
        .clone()
        .unwrap_or_default()
    {
        if !keep.contains(&server.id) {
            let _ = pool().close(&server.id).await;
        }
    }
    let mut by_server = std::collections::HashMap::new();
    for server in &servers {
        match pool().tools(server).await {
            Ok(tools) => {
                by_server.insert(server.id.clone(), tools);
            }
            Err(reason) => eprintln!(
                "[mcp] {} was skipped for this session: {reason}",
                server.name
            ),
        }
    }
    let resolved = praxis_ai::mcp::tool_bridge::resolve_mcp_tools(&servers, &by_server);
    (servers, resolved)
}

/// Calls one bridged tool on its server.
pub(super) async fn call(server: &McpServerConfig, tool: &str, args: &Value) -> (bool, String) {
    match pool().call_tool(server, tool, args).await {
        Ok(result) => (result.ok, result.content),
        Err(message) => (false, message),
    }
}

/// Connects once and lists the tools: what the settings "Test" button shows.
pub(super) fn test_server(candidate: &Value) -> Value {
    use praxis_core::config::mcp_servers::{describe_mcp_server_problem, sanitize_mcp_servers};
    if let Some(problem) = describe_mcp_server_problem(
        candidate["name"].as_str(),
        candidate["transport"].as_str(),
        candidate["url"].as_str(),
        candidate["command"].as_str(),
    ) {
        return json!({ "ok": false, "error": problem });
    }
    let mut draft = candidate.clone();
    if draft["id"].as_str().is_none_or(str::is_empty) {
        draft["id"] = json!("test");
    }
    let Some(config) = sanitize_mcp_servers(Some(&json!([draft])))
        .into_iter()
        .next()
    else {
        return json!({ "ok": false, "error": "That server configuration is not valid." });
    };
    match super::runtime::block_on(pool().probe(&config)) {
        Ok(result) => {
            json!({ "ok": true, "serverName": result.server_name, "tools": result.tools.iter().map(|t| json!({ "name": t.name, "description": t.description })).collect::<Vec<_>>() })
        }
        Err(error) => json!({ "ok": false, "error": error }),
    }
}
