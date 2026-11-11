# BRIEFING — 2026-11-08T16:08:05Z

## Mission
Investigate crates/praxis-workflows and related crates for TASK-522 (service manager with readiness probes) and TASK-523 (cron scheduler, overdue run detection, durable lease recovery) under FX-BE-197.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigation, synthesis
- Working directory: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop
- State folder: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_a
- Original parent: 8a3effd9-ae4a-43a7-85d0-28e432b24c2d
- Milestone: Workstream A Exploration

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Do NOT modify source code or implement fixes
- Produce structured analysis report in handoff.md

## Current Parent
- Conversation ID: 8a3effd9-ae4a-43a7-85d0-28e432b24c2d
- Updated: not yet

## Investigation State
- **Explored paths**:
  - `crates/praxis-workflows/src/` (all 32 modules, specifically `run_service_manager.rs`, `run_profile.rs`, `run_reconciliation.rs`, `scheduled_run*.rs`, `exclusive_resource.rs`)
  - `apps/praxis-desktop/docs/plans/features/fx-bf-114-rust-and-tauri-migration/stories/fx-be-197-workflows-run-profiles-and-scheduler/`
  - `packages/core/src/projects/` and `packages/core/src/scheduledRuns/`
- **Key findings**:
  - `run_service_manager.rs` already fully implements and tests HTTP probes, TCP probes, log-line probes, settle delays, process-group termination, and command exit handling (both before ready and unexpected exits after ready).
  - `scheduled_run_store.rs` and `scheduled_run.rs` implement overdue run detection via `reconcile_on_launch` (transitioning armed runs past start time to `Missed`).
  - `scheduled_run_runner.rs` implements durable lease recovery via `recover()` and `settle_interrupted_launch()` using durable `launch_token`s, preventing double-launch on restart. `exclusive_resource.rs` serializes shared resources.
  - `cron` 0.15 is present in `Cargo.toml` but currently unused. A concrete plan is provided for a Worker to add `cron_scheduler.rs` for recurring cron expressions and overdue detection.
- **Unexplored areas**: none within the scope of Workstream A exploration.

## Key Decisions Made
- Confirmed that current `cargo test -p praxis-workflows` passes 268 tests and clippy is clean.
- Mapped TASK-522 and TASK-523 implementations and detailed the step-by-step worker plan in `handoff.md`.

## Artifact Index
- DISPATCH.md — record of dispatch instructions
- BRIEFING.md — situational awareness
- progress.md — liveness heartbeat
- handoff.md — final comprehensive exploration and handoff report
