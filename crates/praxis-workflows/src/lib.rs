//! Governed delivery workflow engine (`packages/core/src/workflows` port): contracts,
//! finding waivers, stage model selection, check presets, and — as the port proceeds —
//! the run state machine, scheduler, gates, and orchestrator.

pub mod check_presets;
pub mod stage_model;
pub mod types;
pub mod waivers;
