---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-199
title: "Prototype one controlled remote execution path"
status: backlog
story: FX-BE-073
updated: 2026-09-07
dependencies: [TASK-198]
---

# TASK-199: Prototype one controlled remote execution path

**Priority:** Low
**Created:** 2026-09-07

## Goal

Use a disposable runner and a harmless artifact deployment to prove heartbeat, job logs, cancellation acknowledgement and reconnect.

## Implementation entry points

packages/core/src/deployments; architecture documentation. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-198
## Acceptance criteria

- Network loss does not imply job failure or cause duplicate deployment; record operational owner, costs and supported platform assumptions.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


