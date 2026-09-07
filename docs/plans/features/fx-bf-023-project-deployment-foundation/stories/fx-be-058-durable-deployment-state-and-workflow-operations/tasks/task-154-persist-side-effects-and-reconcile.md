---
type: Task
id: TASK-154
title: "Persist side effects and reconcile"
status: planned
story: FX-BE-058
updated: 2026-09-07
dependencies: [TASK-153]
---

# TASK-154: Persist side effects and reconcile

**Priority:** High
**Created:** 2026-09-07

## Goal

Persist operation identity before dispatch, external IDs when known, attempts and reconciliation results; distinguish lost acknowledgement from confirmed failure.

## Implementation entry points

packages/core/src/workflows/workflowTypes.ts; workflowRun.ts; workflowRecovery.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-153
## Acceptance criteria

- Crash after dispatch but before acknowledgement produces unknown and reconciliation, never an automatic second deployment; completed steps are not replayed.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
