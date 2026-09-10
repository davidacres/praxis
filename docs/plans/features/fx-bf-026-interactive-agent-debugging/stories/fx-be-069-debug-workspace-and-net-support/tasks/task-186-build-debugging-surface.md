---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-186
title: "Build debugging surface"
status: planned
story: FX-BE-069
updated: 2026-09-07
dependencies: [FX-BE-068]
---

# TASK-186: Build debugging surface

**Priority:** High
**Created:** 2026-09-07

## Goal

Reuse source highlighting/read-only file viewer; add gutter breakpoint actions, stack/variables panes, run controls, capability states and sidebar/palette navigation.

## Implementation entry points

renderer/src/debugging (new); main/src/main/debugging. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-068
## Acceptance criteria

- Keyboard and themed captures cover running, paused, unavailable source and disconnected sessions; no editable source buffer is introduced.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


