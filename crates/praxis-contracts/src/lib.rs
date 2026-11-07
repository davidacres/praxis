//! Shared IPC and domain contracts for Praxis.
//!
//! Types defined here derive `specta::Type` alongside `serde::{Serialize, Deserialize}`
//! so TypeScript definitions can be exported deterministically.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Health and version metadata returned by the Rust host bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RustHostStatus {
    pub crate_version: String,
    pub protocol_version: u32,
}

impl Default for RustHostStatus {
    fn default() -> Self {
        Self {
            crate_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_host_status_serializes_camel_case() {
        let status = RustHostStatus::default();
        let json = serde_json::to_value(&status).expect("serialize status");
        assert_eq!(json["protocolVersion"], 1);
        assert_eq!(json["crateVersion"], env!("CARGO_PKG_VERSION"));
    }
}
