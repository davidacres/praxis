//! ACP Agent Host, session supervisor, and tool permission gating (`host.rs`).

use std::fs;
use std::path::Path;

use praxis_workflows::types::AgentToolMode;
use serde_json::Value;

use super::protocol::{AcpPermissionDecision, AcpPermissionRequest, AcpToolKind};
use crate::mcp::builtin::read_only_files::resolve_sandboxed_path;

/// Read-only shell commands that are safe to execute even in ReadOnly tool mode.
const READ_ONLY_SHELL_COMMANDS: &[&str] = &[
    "cat",
    "head",
    "tail",
    "grep",
    "rg",
    "find",
    "ls",
    "pwd",
    "git status",
    "git diff",
    "git log",
    "git show",
    "wc",
    "stat",
    "echo",
];

/// Checks if a shell command string consists solely of read-only inspections.
#[must_use]
pub fn is_read_only_shell_command(cmd: &str) -> bool {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return false;
    }

    // Disallow chained commands with side-effects
    if trimmed.contains(';')
        || trimmed.contains('&')
        || trimmed.contains('|')
        || trimmed.contains('>')
    {
        return false;
    }

    let first_token = trimmed.split_whitespace().next().unwrap_or_default();
    if READ_ONLY_SHELL_COMMANDS.contains(&first_token) {
        return true;
    }

    // Git commands prefix check
    if trimmed.starts_with("git ") {
        let subcmd = trimmed.split_whitespace().nth(1).unwrap_or_default();
        return matches!(
            subcmd,
            "status" | "diff" | "log" | "show" | "branch" | "tag"
        );
    }

    false
}

/// Evaluates an ACP permission request against the active session's tool mode.
#[must_use]
pub fn evaluate_permission_request(
    request: &AcpPermissionRequest,
    tool_mode: AgentToolMode,
    auto_approve: bool,
) -> AcpPermissionDecision {
    let kind_is_read_only = request
        .kind
        .as_deref()
        .map(|k| AcpToolKind::from(k).is_read_only())
        .unwrap_or(false);

    let command_str = request.raw_input.as_ref().and_then(|input| {
        input
            .get("command")
            .or_else(|| input.get("cmd"))
            .and_then(Value::as_str)
    });

    let shell_is_read_only = command_str.map(is_read_only_shell_command).unwrap_or(false);
    let is_safe_read_only = kind_is_read_only || shell_is_read_only;

    match tool_mode {
        AgentToolMode::ReadOnly => {
            if is_safe_read_only {
                if auto_approve {
                    AcpPermissionDecision::AllowAlways
                } else {
                    AcpPermissionDecision::AllowOnce
                }
            } else {
                AcpPermissionDecision::Deny
            }
        }
        AgentToolMode::ProjectOnly => {
            if is_safe_read_only {
                AcpPermissionDecision::AllowOnce
            } else {
                // Denies unvetted external modifications
                AcpPermissionDecision::Deny
            }
        }
        AgentToolMode::Full => {
            if auto_approve {
                AcpPermissionDecision::AllowAlways
            } else {
                AcpPermissionDecision::AllowOnce
            }
        }
    }
}

/// Reads a text file within the sandboxed working directory.
pub fn fs_read_text_file(working_directory: &Path, requested_path: &str) -> Result<String, String> {
    let resolved = resolve_sandboxed_path(working_directory, requested_path)?;
    fs::read_to_string(&resolved)
        .map_err(|e| format!("Failed to read sandboxed file '{requested_path}': {e}"))
}

/// Writes a text file within the sandboxed working directory, gated by tool mode.
pub fn fs_write_text_file(
    working_directory: &Path,
    requested_path: &str,
    content: &str,
    tool_mode: AgentToolMode,
) -> Result<(), String> {
    if tool_mode == AgentToolMode::ReadOnly || tool_mode == AgentToolMode::ProjectOnly {
        return Err("File writes are unavailable in read-only tool mode.".to_string());
    }

    let resolved = resolve_sandboxed_path(working_directory, requested_path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories for '{requested_path}': {e}"))?;
    }

    fs::write(&resolved, content)
        .map_err(|e| format!("Failed to write sandboxed file '{requested_path}': {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identifies_read_only_shell_commands() {
        assert!(is_read_only_shell_command("cat README.md"));
        assert!(is_read_only_shell_command("ls -la"));
        assert!(is_read_only_shell_command("git status"));
        assert!(is_read_only_shell_command("git diff HEAD~1"));
        assert!(is_read_only_shell_command("grep -rn pattern ."));

        assert!(!is_read_only_shell_command("rm -rf target"));
        assert!(!is_read_only_shell_command("cargo build"));
        assert!(!is_read_only_shell_command("git commit -m 'oops'"));
        assert!(!is_read_only_shell_command("cat README.md ; rm file"));
    }

    #[test]
    fn gates_permissions_in_read_only_mode() {
        let safe_req = AcpPermissionRequest {
            tool_call_id: "c1".to_string(),
            title: "Read file".to_string(),
            name: Some("fs/read".to_string()),
            kind: Some("read".to_string()),
            raw_input: None,
            options: vec![],
        };
        let safe_dec = evaluate_permission_request(&safe_req, AgentToolMode::ReadOnly, false);
        assert_eq!(safe_dec, AcpPermissionDecision::AllowOnce);

        let mutating_req = AcpPermissionRequest {
            tool_call_id: "c2".to_string(),
            title: "Delete file".to_string(),
            name: Some("fs/delete".to_string()),
            kind: Some("delete".to_string()),
            raw_input: None,
            options: vec![],
        };
        let mutating_dec =
            evaluate_permission_request(&mutating_req, AgentToolMode::ReadOnly, false);
        assert_eq!(mutating_dec, AcpPermissionDecision::Deny);

        let write_cmd_req = AcpPermissionRequest {
            tool_call_id: "c3".to_string(),
            title: "Run command".to_string(),
            name: Some("terminal".to_string()),
            kind: Some("execute".to_string()),
            raw_input: Some(json!({ "command": "cargo build" })),
            options: vec![],
        };
        let write_cmd_dec =
            evaluate_permission_request(&write_cmd_req, AgentToolMode::ReadOnly, false);
        assert_eq!(write_cmd_dec, AcpPermissionDecision::Deny);
    }

    #[test]
    fn auto_approves_safe_actions_when_configured() {
        let req = AcpPermissionRequest {
            tool_call_id: "c4".to_string(),
            title: "Search repo".to_string(),
            name: Some("search".to_string()),
            kind: Some("search".to_string()),
            raw_input: None,
            options: vec![],
        };
        let dec = evaluate_permission_request(&req, AgentToolMode::ReadOnly, true);
        assert_eq!(dec, AcpPermissionDecision::AllowAlways);
    }

    #[test]
    fn sandboxed_fs_blocks_mutations_in_read_only_mode() {
        let temp_dir =
            std::env::temp_dir().join(format!("praxis-acp-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("temp dir");

        let write_res = fs_write_text_file(&temp_dir, "test.txt", "data", AgentToolMode::ReadOnly);
        assert!(write_res.is_err());
        assert!(
            write_res
                .expect_err("write must be blocked")
                .contains("read-only tool mode")
        );

        let write_ok = fs_write_text_file(&temp_dir, "test.txt", "data", AgentToolMode::Full);
        assert!(write_ok.is_ok());

        let read_res = fs_read_text_file(&temp_dir, "test.txt").expect("read succeeds");
        assert_eq!(read_res, "data");

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
