---
**Status:** To Do
**Created:** 2026-11-08
**Type:** Task
**Priority:** High
id: TASK-531
type: Task
status: To Do
priority: High
created: 2026-11-08
updated: 2026-11-08
feature: FX-BF-115
story: FX-BE-201
---

# TASK-531: Enable worktree-bounded subagent task delegation in implementation stages

Parent: [FX-BE-201](../story.md). Design: [FX-BF-115](../../../feature.md).

## Goal and scope

Enhance autonomous agent execution in `workflowAgentStage.ts` and ACP/CLI host runners to support subagent delegation within the stage's isolated worktree:
1. Allow the implementation stage agent to invoke subagents via `task` / `subagent` tools.
2. Enforce sandbox containment: child subagents execute strictly within `worktreePath`.
3. Restrict subagent permissions:
   - Subagents can create, edit, and read files within the worktree.
   - Subagents cannot run git commit, branch checkout, or push commands.
   - Subagents cannot signal stage completion or trigger workflow gates.
4. Record subagent telemetry (`subagent_spawned`, `subagent_state_update`) into the stage transcript so subagent work items are visible in the EasyMode session hierarchy (`extractSubagents`).
5. Ensure graceful failure: if a subagent throws or times out, the error returns to the parent agent as a failed tool call, allowing the parent agent to retry or adjust its approach.

## Dependencies

- [TASK-530](task-530-shared-batch-context-cache.md)

## Acceptance criteria

- Subagent file modifications apply directly to the worktree without conflicting with the parent agent's workspace view.
- Attempts by subagents to access paths outside `worktreePath` are rejected by `resolveSandboxedPath`.
- Subagent lifecycle events are captured in `AgentSessionRecord.events` and mapped cleanly by `readProviderBackgroundUpdate`.
- The parent agent remains the sole entity capable of creating the final stage git commit.

## Validation

Write unit tests in `packages/core/src/ai/acp/acpAgentHost.test.ts` and integration tests in `apps/praxis-desktop/main/e2e/workflowAgentStage.spec.ts` testing subagent spawning, isolation, and failure handling.

## Done when

All acceptance criteria pass and test suites complete with zero regressions.

## Description


## Comments
