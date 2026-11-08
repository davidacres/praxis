---
**Status:** To Do
**Created:** 2026-11-08
**Type:** Task
**Priority:** High
id: TASK-528
type: Task
status: To Do
priority: High
created: 2026-11-08
updated: 2026-11-08
feature: FX-BF-115
story: FX-BE-200
---

# TASK-528: Define ScheduledBatchBlueprint and BatchContext contracts

Parent: [FX-BE-200](../story.md). Design: [FX-BF-115](../../../feature.md).

## Goal and scope

Create `packages/core/src/scheduledRuns/scheduledBatchBlueprint.ts` defining canonical types for whole-schedule coordination:
- `ScheduledBatchBlueprint`: schema version, analyzed timestamp, scheduledRunId, ticketGraph, sharedModules, commonTestTargets, and executionBatches.
- `SharedModuleReference`: file path, estimated symbols, touchingTicketIds, and readOnly vs mutates classification.
- `TicketDependencyEdge`: sourceTicketId, targetTicketId, kind (`blocks` | `extends` | `shares-state` | `independent`), and rationale.
- `BatchExecutionPlan`: ordered stages, recommended parallelism, and warmContextPromptSnippet.

Wire optional `blueprint?: ScheduledBatchBlueprint` onto `ScheduledRun` in `packages/core/src/scheduledRuns/scheduledRun.ts`.

## Dependencies

None

## Acceptance criteria

- `scheduledBatchBlueprint.ts` exports versioned contracts (`BATCH_BLUEPRINT_SCHEMA_VERSION = 1`).
- JSON serialization and deserialization of `ScheduledBatchBlueprint` is lossless and supports immutable cloning.
- Exporting types through `packages/core/src/index.ts` passes `npm run check-core-imports` and `npm run check-types`.

## Validation

Add unit tests in `packages/core/src/scheduledRuns/scheduledBatchBlueprint.test.ts` testing schema validation, round-trip serialization, and contract invariants.

## Done when

All acceptance criteria pass and `npm run test:core` succeeds.

## Description


## Comments
