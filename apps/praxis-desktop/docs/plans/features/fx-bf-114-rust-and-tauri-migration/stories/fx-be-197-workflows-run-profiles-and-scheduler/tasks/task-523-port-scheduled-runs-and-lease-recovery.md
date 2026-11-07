---
**Created:** 2026-11-07T21:21:58.405Z
id: TASK-523
type: Task
status: To Do
---

# Port cron scheduler and durable lease recovery

**Status:** To Do
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


