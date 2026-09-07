---
type: Task
id: TASK-158
title: "Expose direct deployment actions"
status: planned
story: FX-BE-059
updated: 2026-09-07
dependencies: [TASK-157]
---

# TASK-158: Expose direct deployment actions

**Priority:** High
**Created:** 2026-09-07

## Goal

Provide prepare, approve, deploy, health results and explicit rollback actions; unsupported rollback explains the reason and leaves evidence.

## Implementation entry points

main/src/main; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-157
## Acceptance criteria

- A folder-backed project deploys to a temporary local server without GitHub; repeated click and reconnect cannot duplicate execution.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
