//! The desktop side of the mobile companion (`apps/praxis-desktop/main/src/main/mobile*.ts` and
//! the host contracts from `packages/core/src/host/mobile*.ts`).
//!
//! Pure domain logic (pairing, permissions, projections, access policy) sits beside the
//! networking. Where the TS reaches into app services that are not in Rust yet (AI sessions,
//! workflow runs, git), a narrow trait stands in for them — the host implements it later.

pub mod access;
pub mod appearance;
pub mod application;
pub mod gadget_text;
pub mod identity;
mod js_text;
pub mod lan_server;
pub mod ledger;
pub mod pairing;
pub mod pairing_registry;
pub mod permissions;
pub mod protocol;
pub mod relay_client;
pub mod run_projection;
pub mod scheduled_runs;
pub mod services;
pub mod session_changes;
pub mod session_projection;
pub mod session_record;

#[cfg(test)]
pub(crate) mod test_support;
