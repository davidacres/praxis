---
type: Task
id: TASK-189
title: "Expose narrow debug tools"
status: planned
story: FX-BE-070
updated: 2026-09-07
dependencies: [FX-BE-069]
---

# TASK-189: Expose narrow debug tools

**Priority:** High
**Created:** 2026-09-07

## Goal

Provide session-scoped launch/attach, breakpoint, stack, variables, step/continue and stop tools with advertised capabilities; handle application output as untrusted evidence.

## Implementation entry points

packages/core/src/ai; browser MCP pattern; main/src/main/debugging. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-069
## Acceptance criteria

- Gateway and scripted ACP fixtures see equivalent events; read-only analysis cannot start or resume a process.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
