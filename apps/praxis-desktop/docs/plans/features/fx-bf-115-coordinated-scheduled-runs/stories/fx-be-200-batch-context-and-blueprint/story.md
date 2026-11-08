---
**Status:** To Do
**Created:** 2026-11-08
**Type:** Story
**Priority:** High
id: FX-BE-200
type: Story
status: To Do
priority: High
created: 2026-11-08
updated: 2026-11-08
feature: FX-BF-115
---

# FX-BE-200: Batch context analysis and preflight blueprint engine

Parent: [FX-BF-115](../../feature.md).

## User or operational impact

Before executing queued tickets one by one, scheduled runs conduct a unified preflight batch analysis across all tickets in the schedule. The analysis inspects ticket summaries, dependencies, and targeted codebase symbols, producing a structured `ScheduledBatchBlueprint` that maps shared modules, potential collisions, and optimal execution ordering, replacing repetitive per-ticket exploration with a single coordinated pass.

## Scope

- Define typed contracts in `packages/core/src/scheduledRuns/scheduledBatchBlueprint.ts` and export them from `@praxis/core` for `ScheduledBatchBlueprint`, `SharedModuleReference`, `TicketDependencyEdge`, and `BatchExecutionPlan`.
- Implement `buildScheduledBatchBlueprint()` in `packages/core/src/scheduledRuns/` which analyzes the queued `ScheduledTicketRef` items against project metadata and code intelligence to detect shared source files, test suites, and cross-ticket data dependencies.
- Wire the preflight step into `ScheduledRunRunner.advance()` before launching the first ticket, persisting the blueprint onto the `ScheduledRun` state.

## Dependencies

None

## Acceptance criteria

- 528: `scheduledBatchBlueprint.ts` defines versioned contracts (`BATCH_BLUEPRINT_SCHEMA_VERSION = 1`) capturing shared file targets, symbol requirements, dependency ordering, and execution groupings.
- 528: Exporting contracts from `@praxis/core` maintains strict type-only boundaries with renderer (`npm run check-core-imports`).
- 529: Running `buildScheduledBatchBlueprint()` over a set of tickets correctly groups tickets touching identical directories or referencing related ticket IDs (e.g. parent-child, blocked-by).
- 529: The preflight analysis completes in under 15 seconds for a 5-ticket batch and records its findings in `run.blueprint` without mutating the working tree.

## Tasks

- [TASK-528: Define ScheduledBatchBlueprint and BatchContext contracts](tasks/task-528-batch-blueprint-contracts.md)
- [TASK-529: Implement batch preflight architect session and dependency grapher](tasks/task-529-batch-preflight-architect.md)

## Validation

Run `npm run build:core`, `npm run test:core`, and `npm run check-types`.

## Close when

Both tasks satisfy all acceptance criteria and core unit tests pass.

## Description


## Comments
