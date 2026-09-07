---
type: Task
id: TASK-190
title: "Separate inspection from evaluation"
status: planned
story: FX-BE-070
updated: 2026-09-07
dependencies: [TASK-189]
---

# TASK-190: Separate inspection from evaluation

**Priority:** High
**Created:** 2026-09-07

## Goal

Require explicit policy for expression evaluation/function calls and mutating debugger operations; add action/time limits, interrupt and human takeover.

## Implementation entry points

packages/core/src/ai; browser MCP pattern; main/src/main/debugging. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-189
## Acceptance criteria

- Denied evaluation never reaches adapter; abort stops further agent actions; continued processes invalidate pending inspection references.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
