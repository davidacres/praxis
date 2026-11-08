//! MCP client pool, tool namespacing, and output bounds management.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;

use praxis_core::config::mcp_servers::{McpServerConfig, McpTransport, mcp_server_slug};
use serde_json::Value;
use sha1::{Digest, Sha1};

use super::transport::{HttpTransport, McpTransportConnection, StdioTransport};
use super::types::{CallToolResult, MAX_TOOL_NAME, McpProbeResult, McpToolInfo};

/// Namespaces an MCP tool into the standard format `mcp__<server_slug>__<tool_name>`,
/// clamped to 64 characters with a deterministic SHA-1 hash suffix if it exceeds the limit.
#[must_use]
pub fn mcp_tool_name(server_name: &str, tool: &str) -> String {
    let safe_tool: String = tool
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();

    let slug = mcp_server_slug(server_name);
    let full = format!("mcp__{slug}__{safe_tool}");

    if full.len() <= MAX_TOOL_NAME {
        return full;
    }

    let mut hasher = Sha1::new();
    hasher.update(full.as_bytes());
    let hex_hash = format!("{:x}", hasher.finalize());

    format!("{}_{}", &full[..MAX_TOOL_NAME - 7], &hex_hash[..6])
}

fn signature_of(config: &McpServerConfig) -> String {
    format!(
        "{:?}:{:?}:{:?}:{:?}:{:?}:{:?}",
        config.transport, config.url, config.headers, config.command, config.args, config.env
    )
}

struct PoolEntry {
    signature: String,
    connection: Arc<Mutex<Box<dyn McpTransportConnection>>>,
}

/// A connection pool caching active MCP server connections.
#[derive(Default, Clone)]
pub struct McpClientPool {
    connections: Arc<Mutex<HashMap<String, PoolEntry>>>,
}

impl McpClientPool {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn acquire(
        &self,
        config: &McpServerConfig,
    ) -> Result<Arc<Mutex<Box<dyn McpTransportConnection>>>, String> {
        let sig = signature_of(config);
        let mut conns = self.connections.lock().await;

        if let Some(entry) = conns.get(&config.id) {
            if entry.signature == sig {
                return Ok(Arc::clone(&entry.connection));
            }
        }

        // Drop stale connection
        if let Some(old) = conns.remove(&config.id) {
            let mut conn = old.connection.lock().await;
            let _ = conn.close().await;
        }

        let mut transport: Box<dyn McpTransportConnection> = match config.transport {
            McpTransport::Stdio => {
                let cmd = config
                    .command
                    .as_deref()
                    .ok_or_else(|| format!("Server {} missing stdio command", config.name))?;
                let args = config.args.clone().unwrap_or_default();
                let stdio = StdioTransport::spawn(cmd, &args, &config.env).await?;
                Box::new(stdio)
            }
            McpTransport::Http => {
                let url = config
                    .url
                    .as_deref()
                    .ok_or_else(|| format!("Server {} missing HTTP URL", config.name))?;
                let http = HttpTransport::new(url.to_string(), config.headers.clone());
                Box::new(http)
            }
        };

        transport.initialize().await?;

        let connection = Arc::new(Mutex::new(transport));
        conns.insert(
            config.id.clone(),
            PoolEntry {
                signature: sig,
                connection: Arc::clone(&connection),
            },
        );

        Ok(connection)
    }

    /// Retrieves tools from the server, establishing a connection if needed.
    pub async fn tools(&self, config: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
        let conn_arc = self.acquire(config).await?;
        let mut conn = conn_arc.lock().await;
        conn.list_tools().await
    }

    /// Calls a tool on the specified server with arguments.
    pub async fn call_tool(
        &self,
        config: &McpServerConfig,
        tool_name: &str,
        args: &Value,
    ) -> Result<CallToolResult, String> {
        let conn_arc = self.acquire(config).await?;
        let mut conn = conn_arc.lock().await;
        conn.call_tool(tool_name, args).await
    }

    /// Probes an MCP server without caching the connection (useful for connection tests).
    pub async fn probe(&self, config: &McpServerConfig) -> Result<McpProbeResult, String> {
        let mut transport: Box<dyn McpTransportConnection> = match config.transport {
            McpTransport::Stdio => {
                let cmd = config
                    .command
                    .as_deref()
                    .ok_or_else(|| format!("Server {} missing stdio command", config.name))?;
                let args = config.args.clone().unwrap_or_default();
                let stdio = StdioTransport::spawn(cmd, &args, &config.env).await?;
                Box::new(stdio)
            }
            McpTransport::Http => {
                let url = config
                    .url
                    .as_deref()
                    .ok_or_else(|| format!("Server {} missing HTTP URL", config.name))?;
                let http = HttpTransport::new(url.to_string(), config.headers.clone());
                Box::new(http)
            }
        };

        let server_name = transport.initialize().await?;
        let tools = transport.list_tools().await?;
        let _ = transport.close().await;

        Ok(McpProbeResult { server_name, tools })
    }

    /// Closes and removes a specific server connection by ID.
    pub async fn close(&self, id: &str) -> Result<(), String> {
        let mut conns = self.connections.lock().await;
        if let Some(entry) = conns.remove(id) {
            let mut conn = entry.connection.lock().await;
            conn.close().await?;
        }
        Ok(())
    }

    /// Closes all active server connections.
    pub async fn close_all(&self) -> Result<(), String> {
        let mut conns = self.connections.lock().await;
        for (_, entry) in conns.drain() {
            let mut conn = entry.connection.lock().await;
            let _ = conn.close().await;
        }
        Ok(())
    }
}

/// Resolved tool ready for inclusion in an LLM tool prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMcpTool {
    pub namespaced_name: String,
    pub original_tool_name: String,
    pub server_id: String,
    pub server_name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
    pub require_approval: bool,
}

/// Computes resolved namespaced tool definitions for a collection of servers,
/// ensuring unique tool names even in the presence of collisions.
#[must_use]
pub fn resolve_mcp_tools(
    servers: &[McpServerConfig],
    server_tools: &HashMap<String, Vec<McpToolInfo>>,
) -> Vec<ResolvedMcpTool> {
    let mut resolved = Vec::new();
    let mut seen_names: HashSet<String> = HashSet::new();

    for server in servers {
        if !server.enabled {
            continue;
        }
        let Some(tools) = server_tools.get(&server.id) else {
            continue;
        };

        for tool in tools {
            let base_name = mcp_tool_name(&server.name, &tool.name);
            let mut candidate = base_name.clone();
            let mut suffix_num = 2;

            while seen_names.contains(&candidate) {
                let suffix = format!("_{suffix_num}");
                let prefix_len = MAX_TOOL_NAME.saturating_sub(suffix.len());
                candidate = format!("{}{suffix}", &base_name[..prefix_len.min(base_name.len())]);
                suffix_num += 1;
            }

            seen_names.insert(candidate.clone());
            resolved.push(ResolvedMcpTool {
                namespaced_name: candidate,
                original_tool_name: tool.name.clone(),
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                description: tool
                    .description
                    .as_ref()
                    .map(|d| format!("[{}] {d}", server.name)),
                input_schema: tool.input_schema.clone(),
                require_approval: server.require_approval,
            });
        }
    }

    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespaces_tool_with_safe_characters() {
        let name = mcp_tool_name("GitHub Tools", "list_repo_issues");
        assert_eq!(name, "mcp__github_tools__list_repo_issues");
    }

    #[test]
    fn replaces_unsafe_characters_in_tool_name() {
        let name = mcp_tool_name("My Server", "do/something.special:now");
        assert_eq!(name, "mcp__my_server__do_something_special_now");
    }

    #[test]
    fn clamps_long_tool_name_with_sha1_hash() {
        let long_server = "Super Extremely Long Server Display Name For Tools";
        let long_tool = "a_very_long_tool_action_name_that_exceeds_sixty_four_characters_limit";
        let name = mcp_tool_name(long_server, long_tool);
        assert_eq!(name.len(), MAX_TOOL_NAME);
        assert!(name.starts_with("mcp__super_extremely_long_server_display_name_for_tools__"));
        // Last 7 characters are `_<6-hex-hash>`
        let parts: Vec<&str> = name.rsplitn(2, '_').collect();
        assert_eq!(parts[0].len(), 6);
    }

    #[test]
    fn resolves_tool_name_collisions_deterministically() {
        let server1 = McpServerConfig {
            id: "s1".to_string(),
            name: "Tools".to_string(),
            enabled: true,
            transport: McpTransport::Http,
            url: Some("http://localhost:3000".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            require_approval: false,
        };
        let server2 = McpServerConfig {
            id: "s2".to_string(),
            name: "Tools".to_string(),
            enabled: true,
            transport: McpTransport::Http,
            url: Some("http://localhost:3001".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            require_approval: true,
        };

        let mut map = HashMap::new();
        map.insert(
            "s1".to_string(),
            vec![McpToolInfo {
                name: "query".to_string(),
                description: Some("Query tool".to_string()),
                input_schema: None,
            }],
        );
        map.insert(
            "s2".to_string(),
            vec![McpToolInfo {
                name: "query".to_string(),
                description: Some("Duplicate query tool".to_string()),
                input_schema: None,
            }],
        );

        let resolved = resolve_mcp_tools(&[server1, server2], &map);
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0].namespaced_name, "mcp__tools__query");
        assert_eq!(resolved[1].namespaced_name, "mcp__tools__query_2");
        assert!(!resolved[0].require_approval);
        assert!(resolved[1].require_approval);
    }
}
