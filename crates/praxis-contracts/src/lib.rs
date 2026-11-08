//! Shared IPC and domain contracts for Praxis.
//!
//! Types defined here derive `specta::Type` alongside `serde::{Serialize, Deserialize}`
//! so TypeScript definitions in `packages/core/src/host/ipcContracts.ts` can be exported
//! and verified deterministically via `cargo run -p praxis-contracts --bin export-types`.

pub mod domain;
pub mod ipc;

use std::path::Path;

pub use domain::*;
pub use ipc::*;
use specta::TypeCollection;
use specta_typescript::{BigIntExportBehavior, Typescript};

/// Opening marker for the Specta-generated section in `packages/core/src/host/ipcContracts.ts`.
pub const PRAXIS_CONTRACTS_BEGIN_MARKER: &str = "// praxis-contracts:begin";
/// Closing marker for the Specta-generated section in `packages/core/src/host/ipcContracts.ts`.
pub const PRAXIS_CONTRACTS_END_MARKER: &str = "// praxis-contracts:end";

/// Builds the [`TypeCollection`] for all IPC contract types exported into `ipcContracts.ts`.
pub fn ipc_type_collection() -> TypeCollection {
    let mut types = TypeCollection::default();
    register_ipc_types(&mut types);
    types
}

/// Builds the complete [`TypeCollection`] across both IPC and foundational domain types.
pub fn all_type_collection() -> TypeCollection {
    let mut types = TypeCollection::default();
    register_ipc_types(&mut types);
    register_domain_types(&mut types);
    types
}

/// Exports the TypeScript definitions for [`ipc_type_collection`] wrapped in
/// [`PRAXIS_CONTRACTS_BEGIN_MARKER`] and [`PRAXIS_CONTRACTS_END_MARKER`].
pub fn render_ipc_contracts_block() -> Result<String, String> {
    let types = ipc_type_collection();
    let exporter = Typescript::new()
        .bigint(BigIntExportBehavior::Number)
        .header("// Generated from crates/praxis-contracts by `cargo run -p praxis-contracts --bin export-types`.");
    let raw = exporter
        .export(&types)
        .map_err(|err| format!("specta export failed: {err:?}"))?;

    let mut out = String::new();
    out.push_str(PRAXIS_CONTRACTS_BEGIN_MARKER);
    out.push('\n');
    out.push_str(raw.trim());
    out.push('\n');
    out.push_str(PRAXIS_CONTRACTS_END_MARKER);
    Ok(out)
}

/// Replaces the [`PRAXIS_CONTRACTS_BEGIN_MARKER`] .. [`PRAXIS_CONTRACTS_END_MARKER`] section in
/// `existing_source` with the freshly exported TypeScript block.
pub fn update_ipc_contracts_source(existing_source: &str) -> Result<String, String> {
    let generated_block = render_ipc_contracts_block()?;
    let begin_idx = existing_source
        .find(PRAXIS_CONTRACTS_BEGIN_MARKER)
        .ok_or_else(|| {
            format!("missing `{PRAXIS_CONTRACTS_BEGIN_MARKER}` marker in ipcContracts.ts")
        })?;
    let end_rel_idx = existing_source[begin_idx..]
        .find(PRAXIS_CONTRACTS_END_MARKER)
        .ok_or_else(|| {
            format!("missing `{PRAXIS_CONTRACTS_END_MARKER}` marker in ipcContracts.ts")
        })?;
    let end_idx = begin_idx + end_rel_idx + PRAXIS_CONTRACTS_END_MARKER.len();

    let mut updated = String::with_capacity(existing_source.len() + generated_block.len());
    updated.push_str(&existing_source[..begin_idx]);
    updated.push_str(&generated_block);
    updated.push_str(&existing_source[end_idx..]);
    Ok(updated)
}

/// Reads `target_path` (`packages/core/src/host/ipcContracts.ts`), computes the deterministic
/// Specta update, and either verifies (`check_only = true`) or writes it to disk.
pub fn sync_ipc_contracts_file(target_path: &Path, check_only: bool) -> Result<bool, String> {
    let existing = std::fs::read_to_string(target_path)
        .map_err(|err| format!("failed to read {}: {err}", target_path.display()))?;
    let normalized_existing = existing.replace("\r\n", "\n");
    let updated = update_ipc_contracts_source(&normalized_existing)?;
    let changed = updated != normalized_existing;

    if check_only {
        if changed {
            return Err(format!(
                "{} is out of date with crates/praxis-contracts; run `cargo run -p praxis-contracts --bin export-types`",
                target_path.display()
            ));
        }
        return Ok(false);
    }

    if changed {
        std::fs::write(target_path, updated)
            .map_err(|err| format!("failed to write {}: {err}", target_path.display()))?;
    }
    Ok(changed)
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

    #[test]
    fn update_status_tagged_union_matches_typescript_shape() {
        let available = UpdateStatus::Available {
            version: "1.2.3".to_string(),
            can_install: true,
            release_url: None,
        };
        let json = serde_json::to_value(&available).expect("serialize available");
        assert_eq!(json["state"], "available");
        assert_eq!(json["version"], "1.2.3");
        assert_eq!(json["canInstall"], true);
        assert!(json.get("releaseUrl").is_none());
    }

    #[test]
    fn all_domain_and_ipc_types_export_cleanly_to_typescript() {
        let types = all_type_collection();
        let exporter = Typescript::new().bigint(BigIntExportBehavior::Number);
        let ts = exporter.export(&types).expect("export all types");
        assert!(ts.contains("export type RustHostStatus ="));
        assert!(ts.contains("export type UpdateStatus ="));
        assert!(ts.contains("export type BackendMode ="));
        assert!(ts.contains("export type ProjectWorkflowStage ="));
    }

    #[test]
    fn render_ipc_contracts_block_is_deterministic() {
        let first = render_ipc_contracts_block().expect("first render");
        let second = render_ipc_contracts_block().expect("second render");
        assert_eq!(first, second);
        assert!(first.starts_with(PRAXIS_CONTRACTS_BEGIN_MARKER));
        assert!(first.ends_with(PRAXIS_CONTRACTS_END_MARKER));
    }
}
