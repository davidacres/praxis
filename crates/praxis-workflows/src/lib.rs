//! Governed delivery workflow engine (`packages/core/src/workflows` port): contracts,
//! finding waivers, stage model selection, check presets, the durable run state machine,
//! edge/loop semantics, the deterministic scheduler, gates, restart recovery,
//! the async orchestration loop, and the check process runner.

pub mod ai_usage;
pub mod check_presets;
pub mod check_process;
pub mod cron_scheduler;
pub mod deployment_profile;
pub mod deployment_profile_store;
pub mod deployment_run_state;
pub mod deployment_run_store;
pub mod direct_deployment_orchestrator;
pub mod direct_process_executor;
pub mod directory_target;
pub mod edges;
pub mod exclusive_resource;
pub mod gates;
pub mod github_actions_api;
pub mod github_actions_executor;
pub mod github_actions_observer;
pub mod network_probe;
pub mod orchestrator;
pub mod preview_verification;
pub mod process_tree;
pub mod providers;
pub mod publish_manifest;
pub mod recovery;
pub mod run;
pub mod run_profile;
pub mod run_profile_discovery;
pub mod run_profile_store;
pub mod run_reconciliation;
pub mod run_service_manager;
pub mod scheduled_budget;
pub mod scheduled_run;
pub mod scheduled_run_detail;
pub mod scheduled_run_execution;
pub mod scheduled_run_forecast;
pub mod scheduled_run_readiness;
pub mod scheduled_run_request;
pub mod scheduled_run_runner;
pub mod scheduled_run_store;
pub mod scheduled_run_time;
pub mod scheduled_ticket_status;
pub mod scheduler;
pub mod stage_model;
pub mod stage_session;
pub mod terminal_manager;
pub mod types;
pub mod waivers;

#[cfg(test)]
mod mock_http;
#[cfg(test)]
mod test_support;
