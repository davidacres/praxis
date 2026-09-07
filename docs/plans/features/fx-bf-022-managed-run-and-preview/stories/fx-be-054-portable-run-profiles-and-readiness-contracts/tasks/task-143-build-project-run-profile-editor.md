---
type: Task
id: TASK-143
title: "Build project Run profile editor"
status: planned
story: FX-BE-054
updated: 2026-09-07
dependencies: [TASK-142]
---

# TASK-143: Build project Run profile editor

**Priority:** High
**Created:** 2026-09-07

## Goal

Use existing form primitives and themed dialogs, display validation and unavailable-runtime states, and register Run navigation in sidebar and command palette.

## Implementation entry points

packages/core/src/projects; packages/core/src/host/ipcContracts.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-142
## Acceptance criteria

- Profiles remain project-owned with any tracker backend; keyboard, theme and responsive captures show the profile editor and invalid inputs.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
