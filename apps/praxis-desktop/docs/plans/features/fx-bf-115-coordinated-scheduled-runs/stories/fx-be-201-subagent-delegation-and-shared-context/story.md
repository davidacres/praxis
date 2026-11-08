---
**Status:** To Do
**Created:** 2026-11-08
**Type:** Story
**Priority:** High
id: FX-BE-201
type: Story
status: To Do
priority: High
created: 2026-11-08
updated: 2026-11-08
feature: FX-BF-115
---

# FX-BE-201: Subagent stage delegation and shared execution context

Parent: [FX-BF-115](../../feature.md).

## User or operational impact

Workflow stages in a scheduled run share warm codebase context and exploration findings across ticket boundaries, eliminating cold-start tool churn. Autonomous implementation stages can delegate parallel, non-conflicting code edits to bounded subagents within their worktree, accelerating execution while retaining stage-level deterministic verification and commit boundaries.

## Scope

- Implement `BatchContextCache` in `packages/core/src/scheduledRuns/batchContextCache.ts` to retain and format warm context (shared file summaries, architectural patterns, and previous ticket delivery deliverables) across stages in the same scheduled run.
- Update `workflowAgentStage.ts` in `@praxis/desktop-main` to inject warm batch context into stage prompt definitions (`taskDefinition.scope`).
- Enhance the implementation stage runtime environment to support worktree-bounded subagent task delegation:
  - Subagents inherit the stage worktree path.
  - Subagents run under the parent stage's tool policy.
  - Subagents cannot perform git commits or stage transitions; all changes are returned to the parent stage agent.
- Ensure deterministic `check` stages and independent `review` stages remain decoupled from subagent execution.

## Dependencies

- [FX-BE-200](../fx-be-200-batch-context-and-blueprint/story.md)

## Acceptance criteria

- 530: When Ticket 2 runs after Ticket 1 in the same schedule, Ticket 2's `taskDefinition.scope` contains Ticket 1's handover brief, touched files list, and pre-computed symbol maps.
- 530: Stages accessing files already inspected in earlier stages skip redundant `read_file` or `search_code` calls in at least 70% of observed cases.
- 531: An implementation stage agent invoking a subagent (`task` / `subagent`) executes the child task in the same isolated worktree without file locking collisions.
- 531: Subagents cannot bypass tool restrictions: a read-only subagent cannot edit files, and no subagent can commit directly to git or advance the workflow stage.
- 531: Any error or uncaught exception inside a subagent surfaces cleanly to the parent stage agent as a failed tool result rather than crashing the Electron main process.

## Tasks

- [TASK-530: Implement shared batch context cache and stage context injection](tasks/task-530-shared-batch-context-cache.md)
- [TASK-531: Enable worktree-bounded subagent task delegation in implementation stages](tasks/task-531-worktree-subagent-delegation.md)

## Validation

Run `npm run test:core`, `npm run test:desktop:git`, and Playwright stage execution specs.

## Close when

Both tasks satisfy all acceptance criteria and automated tests confirm safe context propagation and subagent execution.

## Description


## Comments
