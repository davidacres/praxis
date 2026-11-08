//! Governed delivery workflow engine (`packages/core/src/workflows` port): contracts,
//! finding waivers, stage model selection, check presets, the durable run state machine,
//! edge/loop semantics, the deterministic scheduler, gates, restart recovery,
//! the async orchestration loop, and the check process runner.

pub mod check_presets;
pub mod check_process;
pub mod edges;
pub mod gates;
pub mod orchestrator;
pub mod providers;
pub mod recovery;
pub mod run;
pub mod scheduler;
pub mod stage_model;
pub mod stage_session;
pub mod types;
pub mod waivers;
