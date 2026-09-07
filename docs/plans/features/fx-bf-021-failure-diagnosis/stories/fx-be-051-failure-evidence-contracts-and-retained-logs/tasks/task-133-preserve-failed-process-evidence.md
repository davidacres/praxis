---
type: Task
id: TASK-133
title: "Preserve failed process evidence"
status: planned
story: FX-BE-051
updated: 2026-09-07
dependencies: [TASK-132]
---

# TASK-133: Preserve failed process evidence

**Priority:** High
**Created:** 2026-09-07

## Goal

Capture stdout/stderr and process status on exit, timeout, cancellation and spawn error; return artifact references whenever capture succeeded and expose persistence failure explicitly.

## Implementation entry points

packages/core/src/workflows; main/src/main/workflowCheckRunner.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-132
## Acceptance criteria

- A timed-out command retains its emitted marker and timeout reason; a spawn failure is visible; output-write failure cannot masquerade as complete evidence.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
