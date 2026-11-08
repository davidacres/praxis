//! Core deterministic domain logic for Praxis:
//! settings sanitization, workspaces, project workflows, folder markdown plans,
//! git CLI parsing/worktrees, path sandboxing, unified diffs, and marketplace archives.

pub mod config;
pub mod folder;
pub mod git;
pub mod issues;
pub mod marketplace;
pub mod network_address;
pub mod projects;
pub mod sandbox;
pub mod ui;
pub mod unified_diff;
pub mod workspaces;

use praxis_contracts::RustHostStatus;

/// Returns the core crate identifier and contract protocol version.
#[must_use]
pub fn core_status() -> RustHostStatus {
    RustHostStatus::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_status_matches_workspace_version() {
        let status = core_status();
        assert_eq!(status.protocol_version, 1);
    }
}
