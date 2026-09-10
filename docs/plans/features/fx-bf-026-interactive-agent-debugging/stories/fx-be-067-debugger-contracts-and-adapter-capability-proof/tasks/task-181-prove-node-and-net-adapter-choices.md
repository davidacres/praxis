---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-181
title: "Prove Node and .NET adapter choices"
status: To Do
story: FX-BE-067
updated: 2026-09-07
dependencies: [TASK-180]
---

# TASK-181: Prove Node and .NET adapter choices

**Priority:** High
**Created:** 2026-09-07

## Goal

Inspect current official adapter docs/licenses; run a bounded Node fixture and evaluate netcoredbg or another supported CoreCLR DAP adapter against required OS/runtime targets.

## Implementation entry points

packages/core/src/debugging (new); main/src/main. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-180
## Acceptance criteria

- Record exact versions, launch/attach and source-map results, distribution decision and unsupported capabilities; do not assume Microsoft debugger redistribution rights.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


