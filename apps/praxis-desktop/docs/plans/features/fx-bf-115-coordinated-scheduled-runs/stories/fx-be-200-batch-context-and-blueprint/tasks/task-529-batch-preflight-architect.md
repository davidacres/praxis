---
**Status:** To Do
**Created:** 2026-11-08
**Type:** Task
**Priority:** High
id: TASK-529
type: Task
status: To Do
priority: High
created: 2026-11-08
updated: 2026-11-08
feature: FX-BF-115
story: FX-BE-200
---

# TASK-529: Implement batch preflight architect session and dependency grapher

Parent: [FX-BE-200](../story.md). Design: [FX-BF-115](../../../feature.md).

## Goal and scope

Implement `buildScheduledBatchBlueprint()` in `packages/core/src/scheduledRuns/scheduledBatchAnalyzer.ts`.
The analyzer:
1. Gathers all pending tickets in the scheduled run (`run.entries`).
2. Extracts ticket titles, descriptions, and file path mentions using regex and AST heuristics.
3. Queries code intelligence symbol references for mentioned types or functions to identify shared source files.
4. Detects dependency relationships (explicit dependency lines, common module mutations, or sequential prerequisite indicators).
5. Assembles an execution DAG that flags tickets that can safely share warm context and tickets that must execute strictly sequentially.
6. Integrates into `ScheduledRunRunner.advance()`: runs once when `run.status === 'running'` before the first ticket launches, saving `run.blueprint`.

## Dependencies

- [TASK-528](task-528-batch-blueprint-contracts.md)

## Acceptance criteria

- `buildScheduledBatchBlueprint` constructs a valid `ScheduledBatchBlueprint` for a multi-ticket schedule without spawning an external agent if static references suffice, or using a lightweight read-only discovery session if deep symbol resolution is needed.
- Cycles in inferred ticket dependencies are detected and resolved gracefully by falling back to queue declaration order.
- The preflight blueprint is recorded on `ScheduledRun.blueprint` and emitted in schedule change events (`ports.onChanged`).
- Execution of the preflight analysis does not modify any repository files or working tree checkouts.

## Validation

Add unit tests in `packages/core/src/scheduledRuns/scheduledBatchAnalyzer.test.ts` covering multi-ticket batches with shared dependencies, independent parallel tickets, and circular dependencies.

## Done when

Unit tests pass and `buildScheduledBatchBlueprint` integrates cleanly with `ScheduledRunRunner`.

## Description


## Comments
