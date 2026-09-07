---
type: Task
id: TASK-185
title: "Expose typed debugger IPC"
status: planned
story: FX-BE-068
updated: 2026-09-07
dependencies: [TASK-184]
---

# TASK-185: Expose typed debugger IPC

**Priority:** High
**Created:** 2026-09-07

## Goal

Provide validated IPC commands and push updates with bounded payloads and per-session authorization.

## Implementation entry points

main/src/main/debugging (new); packages/core/src/host/ipcContracts.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-184
## Acceptance criteria

- Renderer cannot send arbitrary raw adapter commands; multiple sessions stay isolated and unsupported operations are visibly unavailable.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
