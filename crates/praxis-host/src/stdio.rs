//! Newline-delimited JSON (NDJSON) wire framing for the persistent `praxis-host --stdio` bridge
//! between Electron (`rustHostBridge.ts`) and [`crate::HostContext`].

use praxis_contracts::{RustEventEnvelope, RustHostStatus, RustRpcResponse};
use serde::{Deserialize, Serialize};

/// Outbound frame written by `praxis-host --stdio` to stdout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostWireFrame {
    /// Emitted once immediately after `HostContext` initialization completes.
    #[serde(rename_all = "camelCase")]
    Ready {
        status: RustHostStatus,
        registered_channels: Vec<String>,
    },
    /// Response to an inbound [`praxis_contracts::RustRpcRequest`].
    #[serde(rename_all = "camelCase")]
    Response { envelope: RustRpcResponse },
    /// Unsolicited server-pushed event emitted on [`crate::HostEventBus`].
    #[serde(rename_all = "camelCase")]
    Event { envelope: RustEventEnvelope },
}
