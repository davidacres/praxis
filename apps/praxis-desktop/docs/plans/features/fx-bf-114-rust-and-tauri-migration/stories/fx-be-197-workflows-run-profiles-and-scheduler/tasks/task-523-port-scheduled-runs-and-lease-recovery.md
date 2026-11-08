---
**Created:** 2026-11-07T21:21:58.405Z
id: TASK-523
type: Task
status: In Progress
---

# Port cron scheduler and durable lease recovery

**Status:** In Progress
**Type:** Task
**Priority:** Medium

## Description

Port `packages/core/src/scheduledRuns/` (`scheduledRunStore`, `scheduledBudget`, `scheduledRunRunner`, `scheduledRunParallel`, and `scheduledTicketStatus`) and `apps/praxis-desktop/main/src/main/scheduledRunDaemon.ts` into `crates/praxis-workflows`. Ensure durable lease locks, budget enforcement, provider quota handovers, and crash recovery operate identically.

## Acceptance Criteria

- All `scheduledRuns` unit tests pass in `cargo test -p praxis-workflows`.
- `scheduledProviderHandover.spec.ts` passes.

## Dependencies

- `TASK-521`

## Comments

## Comments

- 2026-11-08: Six commits. The core of `packages/core/src/scheduledRuns/` is now in `crates/praxis-workflows`, split the way the TypeScript was: `scheduled_run` (the durable definition and its pure operations), `scheduled_run_store` (durable storage over a key-value backend), `scheduled_run_time` (IANA zones), `scheduled_budget` (which provider a ticket may run on), `scheduled_run_execution` (the transitions the runner applies), `scheduled_run_runner` (the orchestration, with every side effect behind a port), `scheduled_run_readiness`, `scheduled_ticket_status`, `exclusive_resource`, `scheduled_run_request`, `scheduled_run_forecast` and `scheduled_run_detail` (the stage order), plus `ai_usage` for the usage-event shape the forecast reads.
- The runner's guarantees are covered by tests with a fake host: the entry is saved with a launch token before the workflow is launched, so a crash never launches a ticket twice (the run is found again by its token, or the schedule pauses as `launch-interrupted` and asks); all work for one schedule goes through one chain, so a workflow-change event that arrives mid-step queues behind it instead of being dropped; a failure never lets the run move past it by itself. The budget rules are covered too: a provider that ran out is never chosen again, a provider the ticket was already moved away from is never a hand-over target again, and a provider that reports nothing is used rather than stopping the run.
- One behaviour fixed on the way: `ScheduledRunStore::rename` edited a run through the editable-gated operation, so a finished run could not be given a descriptive label. The store renames on any status, as it did before.
- Verification: `cargo test -p praxis-workflows` passes (234 library tests, plus the crate's integration and doc tests); `cargo clippy --workspace --all-targets --all-features -- -D warnings` is clean; `cargo run -p praxis-contracts --bin export-types -- --check` reports the contracts up to date. The TypeScript baseline still passes — `node --test out/scheduledRuns/*.test.js` is 159 pass, 0 fail.
- Still open: `scheduledRunDetail`'s per-entry view (`scheduledEntryDetail`), `stageActivityLine` and `describeToolEvent` read `WorkflowRunSummary`/`StageRow` and `AgentEventSummary`, which have no Rust port; those belong to FX-BE-193's run-monitor scope (`workflowRunSummary.ts`, `agentTypes.ts`). There is no `apps/praxis-desktop/main/src/main/scheduledRunDaemon.ts` to port — the nearest is `scheduledRunRunnerInstance.ts`, whose ports need the provider quota adapters (`praxis-ai` is still a stub), the board tracker (`praxis-trackers` has only `folder_service`) and the workflow launch, so that wiring lands when those crates do. `scheduledProviderHandover.spec.ts` is a Playwright spec over the Electron app and was not run here: it needs the desktop build and a running app.
- Note on scope: there is no `scheduledRunParallel.ts`; the parallel behaviour lives in the runner, and `scheduledRunParallel.test.ts` exercises it there. Its exclusive-resource half is `exclusive_resource.rs`.
- 2026-11-08: Added `cron_scheduler.rs` in `crates/praxis-workflows` using `cron::Schedule` and `chrono_tz::Tz`. Implemented `CronSchedule` supporting 5-, 6-, and 7-field cron expressions, timezone normalization, `next_after`, and `find_overdue_runs` for missed run detection. Added 12 unit tests in `cron_scheduler` covering valid expressions, timezone conversions, edge boundaries, and overdue intervals. All 280 tests in `cargo test -p praxis-workflows` pass and `cargo clippy --all-targets --all-features -- -D warnings` is clean.
