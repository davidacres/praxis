---
type: Task
id: TASK-187
title: "Integrate .NET launch and attach"
status: planned
story: FX-BE-069
updated: 2026-09-07
dependencies: [TASK-186]
---

# TASK-187: Integrate .NET launch and attach

**Priority:** High
**Created:** 2026-09-07

## Goal

Use adapter chosen by the capability proof, .NET launch settings and explicit process selection; handle symbols and remote/container path mapping only where validated.

## Implementation entry points

renderer/src/debugging (new); main/src/main/debugging. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-186
## Acceptance criteria

- A C# fixture launches, stops at a breakpoint, exposes locals and detaches correctly; missing symbols and unsupported runtime produce actionable states.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
