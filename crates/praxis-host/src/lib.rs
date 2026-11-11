//! Shell-agnostic service container, RPC dispatcher, and event broadcast bus
//! backing the Electron main process (via N-API / JSON-RPC) and headless test runs.

pub mod ai_bridge;
pub mod call_client;
pub mod config;
pub mod context;
pub mod deployment_bridge;
pub mod events;
pub mod mobile_bridge;
#[cfg(feature = "napi-addon")]
pub mod napi_bridge;
pub mod profile_bridge;
pub mod electron_secrets;
pub mod secret_backends;
pub mod secrets;
pub mod services;
pub mod stdio;
pub mod terminal_bridge;
pub mod tracker_bridge;
pub mod workflow_bridge;
mod workflow_reads;

pub use call_client::{HostCallClient, HostCallError};
pub use config::{HostConfig, HostConfigError};
pub use context::{HostContext, RpcHandlerFn};
pub use events::{EventSubscriptionId, HostEventBus};
use praxis_contracts::RustHostStatus;
use praxis_core::core_status;
pub use secrets::HostSecretStore;
pub use services::HostServices;
pub use stdio::{HostInboundReply, HostWireFrame};
pub use workflow_bridge::{
    GateActionResultDto, GateEvaluationResult, StageApproval, WorkflowPolicy,
    register_workflow_channels,
};

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
