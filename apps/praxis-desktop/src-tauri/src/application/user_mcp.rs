//! The MCP servers the user added (Settings > AI Provider > Tools), put in front of their CLI
//! agents at session start (`userMcp.ts`'s `userMcpAcpServers`). The agent connects to them
//! itself over ACP. Full-tools sessions only: a user-added server can do whatever its tools
//! allow, so a read-only session never gets it.

use praxis_core::config::mcp_servers::{McpServerConfig, McpTransport, enabled_mcp_servers, mcp_server_slug};
use praxis_host::HostContext;
use serde_json::{Value, json};

/// Explicit egress consent follows the destination provider, including after handover.
fn applies_to_provider(server: &McpServerConfig, provider: &str) -> bool {
    if let Some(destination) = server.env.as_ref().and_then(|env| env.get("PRAXIS_CODE_INTELLIGENCE_PROVIDER")).filter(|d| !d.is_empty()) {
        return provider == destination;
    }
    let bridge = |arg: &String| arg.ends_with("codeIntelligence/mcpBridge.js") || arg.ends_with("codeIntelligence\\mcpBridge.js");
    !(server.id.starts_with("praxis-code-intelligence-") || server.args.as_ref().is_some_and(|args| args.iter().any(bridge)))
}

fn active_servers(host: &HostContext, tool_mode: &str, provider: &str) -> Vec<McpServerConfig> {
    if tool_mode != "full" {
        return Vec::new();
    }
    let configured = host.settings().read().ai.mcp_servers.clone().unwrap_or_default();
    enabled_mcp_servers(&configured).into_iter().filter(|server| applies_to_provider(server, provider)).collect()
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
