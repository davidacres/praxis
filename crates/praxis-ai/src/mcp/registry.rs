//! Central registry for MCP servers and tool discovery (`registry.rs`).

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use praxis_core::config::mcp_servers::McpServerConfig;
use serde_json::Value;

use super::builtin::{
    CoordinationHub, TrackerProvider, execute_browser_tool, execute_coordination_tool,
    execute_read_only_file_tool, execute_tracker_tool, list_browser_tools, list_coordination_tools,
    list_read_only_file_tools, list_tracker_tools,
};
use super::tool_bridge::{McpClientPool, ResolvedMcpTool, resolve_mcp_tools};
use super::types::CallToolResult;
use praxis_workflows::types::AgentToolMode;

/// Central registry managing external configured and built-in MCP servers.
#[derive(Clone)]
pub struct McpServerRegistry {
    servers: Arc<Mutex<HashMap<String, McpServerConfig>>>,
    coordination_hub: CoordinationHub,
    tracker_provider: Option<Arc<dyn TrackerProvider>>,
    review_root: Option<std::path::PathBuf>,
}

impl Default for McpServerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl McpServerRegistry {
    pub fn new() -> Self {
        Self {
            servers: Arc::new(Mutex::new(HashMap::new())),
            coordination_hub: CoordinationHub::new(),
            tracker_provider: None,
            review_root: None,
        }
    }

    pub fn with_tracker(mut self, provider: Arc<dyn TrackerProvider>) -> Self {
        self.tracker_provider = Some(provider);
        self
    }

    pub fn with_review_root(mut self, root: std::path::PathBuf) -> Self {
        self.review_root = Some(root);
        self
    }

    pub fn coordination_hub(&self) -> &CoordinationHub {
        &self.coordination_hub
    }

    /// Registers a user-configured server.
    pub async fn register_server(&self, config: McpServerConfig) {
        let mut map = self.servers.lock().await;
        map.insert(config.id.clone(), config);
    }

    /// Unregisters a server by ID.
    pub async fn unregister_server(&self, id: &str) -> Option<McpServerConfig> {
        let mut map = self.servers.lock().await;
        map.remove(id)
    }

    /// Returns a list of all registered servers.
    pub async fn list_servers(&self) -> Vec<McpServerConfig> {
        let map = self.servers.lock().await;
        map.values().cloned().collect()
    }

    /// Gathers all available tools from built-in servers and enabled external servers.
    pub async fn list_tools(&self, pool: &McpClientPool) -> Result<Vec<ResolvedMcpTool>, String> {
        let servers: Vec<McpServerConfig> = {
            let map = self.servers.lock().await;
            map.values().filter(|s| s.enabled).cloned().collect()
        };

        let mut server_tools = HashMap::new();
        for server in &servers {
            match pool.tools(server).await {
                Ok(tools) => {
                    server_tools.insert(server.id.clone(), tools);
                }
                Err(_err) => {
                    // Stale or unreachable servers are skipped and reported gracefully
                }
            }
        }

        let mut all_tools = resolve_mcp_tools(&servers, &server_tools);

        // Add built-in tools
        if let Some(ref _root) = self.review_root {
            for tool in list_read_only_file_tools() {
                all_tools.push(ResolvedMcpTool {
                    namespaced_name: format!("mcp__files__{}", tool.name),
                    original_tool_name: tool.name,
                    server_id: "builtin-files".to_string(),
                    server_name: "files".to_string(),
                    description: tool.description,
                    input_schema: tool.input_schema,
                    require_approval: false,
                });
            }
        }

        if self.tracker_provider.is_some() {
            for tool in list_tracker_tools() {
                all_tools.push(ResolvedMcpTool {
                    namespaced_name: format!("mcp__tracker__{}", tool.name),
                    original_tool_name: tool.name,
                    server_id: "builtin-tracker".to_string(),
                    server_name: "tracker".to_string(),
                    description: tool.description,
                    input_schema: tool.input_schema,
                    require_approval: false,
                });
            }
        }

        for tool in list_coordination_tools() {
            all_tools.push(ResolvedMcpTool {
                namespaced_name: format!("mcp__coordination__{}", tool.name),
                original_tool_name: tool.name,
                server_id: "builtin-coordination".to_string(),
                server_name: "coordination".to_string(),
                description: tool.description,
                input_schema: tool.input_schema,
                require_approval: false,
            });
        }

        for tool in list_browser_tools() {
            all_tools.push(ResolvedMcpTool {
                namespaced_name: format!("mcp__browser__{}", tool.name),
                original_tool_name: tool.name,
                server_id: "builtin-browser".to_string(),
                server_name: "browser".to_string(),
                description: tool.description,
                input_schema: tool.input_schema,
                require_approval: false,
            });
        }

        Ok(all_tools)
    }

    /// Dispatches a tool call to the appropriate built-in server or pooled client.
    pub async fn call_tool(
        &self,
        pool: &McpClientPool,
        tool_name: &str,
        args: &Value,
        session_id: &str,
        tool_mode: AgentToolMode,
    ) -> Result<CallToolResult, String> {
        // Built-in routing
        if let Some(rest) = tool_name.strip_prefix("mcp__files__") {
            if let Some(ref root) = self.review_root {
                return execute_read_only_file_tool(root, rest, args);
            }
            return Ok(CallToolResult::failure("Files server is not configured"));
        }

        if let Some(rest) = tool_name.strip_prefix("mcp__tracker__") {
            if let Some(ref tracker) = self.tracker_provider {
                return execute_tracker_tool(rest, args, tool_mode, tracker.as_ref()).await;
            }
            return Ok(CallToolResult::failure("Tracker server is not configured"));
        }

        if let Some(rest) = tool_name.strip_prefix("mcp__coordination__") {
            return execute_coordination_tool(rest, args, session_id, &self.coordination_hub).await;
        }

        if let Some(rest) = tool_name.strip_prefix("mcp__browser__") {
            return execute_browser_tool(rest, args);
        }

        // External server routing
        let all_tools = self.list_tools(pool).await?;
        let matching = all_tools
            .into_iter()
            .find(|t| t.namespaced_name == tool_name);

        let Some(tool_match) = matching else {
            return Ok(CallToolResult::failure(format!(
                "Unknown MCP tool: {tool_name}"
            )));
        };

        let server_config = {
            let map = self.servers.lock().await;
            map.get(&tool_match.server_id).cloned()
        };

        let Some(config) = server_config else {
            return Ok(CallToolResult::failure(format!(
                "Server {} not found for tool {}",
                tool_match.server_name, tool_name
            )));
        };

        pool.call_tool(&config, &tool_match.original_tool_name, args)
            .await
    }
}
