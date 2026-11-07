//! Shell-agnostic service container, RPC dispatcher, and event broadcast bus
//! backing the Electron main process (via N-API / JSON-RPC) and headless test runs.

use praxis_contracts::RustHostStatus;
use praxis_core::core_status;

/// Returns the current status of the Praxis Rust host container.
#[must_use]
pub fn host_status() -> RustHostStatus {
    core_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_status_reports_protocol_v1() {
        let status = host_status();
        assert_eq!(status.protocol_version, 1);
    }
}
