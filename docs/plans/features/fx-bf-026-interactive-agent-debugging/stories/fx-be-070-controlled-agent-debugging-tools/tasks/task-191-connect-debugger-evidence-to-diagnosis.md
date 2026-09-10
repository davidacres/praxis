---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-191
title: "Connect debugger evidence to diagnosis"
status: planned
story: FX-BE-070
updated: 2026-09-07
dependencies: [TASK-190]
---

# TASK-191: Connect debugger evidence to diagnosis

**Priority:** High
**Created:** 2026-09-07

## Goal

Attach stopped location, bounded state snapshot and source revision to diagnosis; finish with normal deterministic tests after the debugged repair.

## Implementation entry points

packages/core/src/ai; browser MCP pattern; main/src/main/debugging. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-190
## Acceptance criteria

- Agent fixture identifies a seeded runtime-state defect, proposes a fix and yields independently passing tests; logs distinguish hypotheses from observed runtime state.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


