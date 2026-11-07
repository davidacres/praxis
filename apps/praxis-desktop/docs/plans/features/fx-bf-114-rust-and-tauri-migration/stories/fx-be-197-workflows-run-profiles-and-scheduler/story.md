---
**Created:** 2026-11-07T21:21:54.939Z
id: FX-BE-197
type: Story
status: To Do
---

# Port Workflow Engine, Managed Run Services, and Scheduled Runs

**Status:** To Do
**Type:** Story
**Priority:** High

## Description

Port the governed workflow orchestrator (`packages/core/src/workflows/`), stage state machines, threshold/multi-owner gates, review-fix loops, check runners, run profile service manager (`runServiceManager.ts`), deployment orchestrators (`packages/core/src/deployments/`), and cron-based scheduled runs (`packages/core/src/scheduledRuns/`) into `crates/praxis-workflows`.

### Execution Order & Parallelism (Wave 3 — Parallel with FX-BE-196 & FX-BE-198)

- **Story-Level Concurrency**: Runs in Wave 3 in `crates/praxis-workflows` simultaneously with `FX-BE-196` (`praxis-trackers` / `praxis-mobile`) and `FX-BE-198` (`praxis-ai`).
- **Task-Level Concurrency**: `TASK-521` (stage state machine, gates, and check runner) executes first, then fans out into `TASK-522` (managed run services & deployments) and `TASK-523` (cron scheduler & lease recovery) in parallel.

## Tasks

- `TASK-521` (`High`, Sequential Step 1) — Port workflow stage state machine, gates, and check runner
- `TASK-522` (`High`, Parallel Step 2A) — Port runServiceManager and deployment target runners
- `TASK-523` (`Medium`, Parallel Step 2B) — Port cron scheduler and durable lease recovery

## Acceptance Criteria

- All workflow unit suites (`workflowOrchestrator`, `workflowGates`, `workflowLoops`, `checkFindings`, `runServiceManager`, `scheduledRunRunner`) pass in `cargo test -p praxis-workflows`.
- All `workflow*.spec.ts` and `scheduledProviderHandover.spec.ts` E2E smoke specs pass.

## Dependencies

- `FX-BE-195`

## Comments


