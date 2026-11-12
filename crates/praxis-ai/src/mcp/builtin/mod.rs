//! Built-in MCP server implementations.

pub mod browser;
pub mod coordination;
pub mod read_only_files;
pub mod tracker;

pub use browser::{BROWSER_MCP_SERVER_NAME, execute_browser_tool, list_browser_tools};
pub use coordination::{
    COORDINATION_MCP_SERVER_NAME, CoordinationHub, CoordinationSessionHooks,
    execute_coordination_tool, execute_coordination_tool_with_hooks, list_coordination_tools,
};
pub use read_only_files::{
    READ_ONLY_FILES_SERVER_NAME, execute_read_only_file_tool, list_read_only_file_tools,
    resolve_sandboxed_path,
};
pub use tracker::{TrackerProvider, execute_tracker_tool, list_tracker_tools};
