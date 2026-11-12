//! Session coordination (FX-BF-048): one local broker that grants ownership of shared things
//! (a file, a checkout, the live app, the in-app browser, a port, a process group) to one
//! session at a time, before the side effect.
//!
//! - [`types`] — the wire shapes (JSON-compatible with the retired TypeScript broker).
//! - [`policy`] — which claims conflict.
//! - [`broker`] — the process-independent state machine, [`broker::apply`].
//! - [`host`] — the process side: lock, token, persisted state, local socket, leader and follower.
//! - [`gate`] — what a tool executor asks before a side effect.

pub mod broker;
pub mod change_scope;
pub mod gate;
pub mod host;
pub mod policy;
pub mod types;

pub use broker::{apply, empty_state, scoped_snapshot};
pub use gate::{COORDINATION_MAX_WAIT_MS, GateDecision, refusal_for_agent};
pub use policy::{claims_conflict, describe_resource};
pub use types::*;
