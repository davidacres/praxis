//! Governed delivery workflow engine (`packages/core/src/workflows` port): contracts,
//! finding waivers, stage model selection, check presets, the durable run state machine,
//! edge/loop semantics, the deterministic scheduler, gates, restart recovery,
//! the async orchestration loop, and the check process runner.

pub mod check_presets;
pub mod check_process;
pub mod edges;
pub mod gates;
pub mod orchestrator;
pub mod preview_verification;
pub mod providers;
pub mod recovery;
pub mod run;
pub mod run_profile;
pub mod run_profile_discovery;
pub mod run_profile_store;
pub mod run_reconciliation;
pub mod run_service_manager;
pub mod scheduled_run;
pub mod scheduled_run_store;
pub mod scheduled_run_time;
pub mod scheduler;
pub mod stage_model;
pub mod stage_session;
pub mod types;
pub mod waivers;

#[cfg(test)]
mod test_support;
