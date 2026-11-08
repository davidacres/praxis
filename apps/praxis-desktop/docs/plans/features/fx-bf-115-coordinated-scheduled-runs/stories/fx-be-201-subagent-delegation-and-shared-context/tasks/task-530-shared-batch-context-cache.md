---
**Status:** To Do
**Created:** 2026-11-08
**Type:** Task
**Priority:** High
id: TASK-530
type: Task
status: To Do
priority: High
created: 2026-11-08
updated: 2026-11-08
feature: FX-BF-115
story: FX-BE-201
---

# TASK-530: Implement shared batch context cache and stage context injection

Parent: [FX-BE-201](../story.md). Design: [FX-BF-115](../../../feature.md).

## Goal and scope

Create `packages/core/src/scheduledRuns/batchContextCache.ts` and integrate it into `apps/praxis-desktop/main/src/main/workflowAgentStage.ts`:
1. `BatchContextCache` maintains an in-memory cache of:
   - Evaluated `ScheduledBatchBlueprint`.
   - File briefs and symbol exports discovered by earlier stages in the run.
   - Handover briefs (`AgentSessionRecord.handoverBrief`) and touched file paths from completed tickets.
2. In `workflowAgentStage.ts`:
   - If the workflow run has a `scheduledLaunchToken`, query the schedule runner for the run's `BatchContextCache`.
   - Format a compact Markdown section: `## Scheduled Batch Context` containing relevant shared modules and preceding ticket summaries.
   - Inject the section into `taskDefinition.scope`.
   - Cap the injected section length to 8,000 characters to prevent prompt bloat.

## Dependencies

- [TASK-528](../../fx-be-200-batch-context-and-blueprint/tasks/task-528-batch-blueprint-contracts.md)

## Acceptance criteria

- `formatBatchContextSection()` formats preceding ticket deliveries and shared module outlines without exceeding the 8,000 character budget.
- Only tickets belonging to the same scheduled run share cache entries; independent or manual runs never receive cross-run state.
- Injected context preserves code fences and file link syntax compatible with Markdown parser contracts.

## Validation

Unit tests in `packages/core/src/scheduledRuns/batchContextCache.test.ts` verifying cache insertion, pruning, length bounding, and formatting.

## Done when

All acceptance criteria pass and `npm run test:core` succeeds.

## Description


## Comments
