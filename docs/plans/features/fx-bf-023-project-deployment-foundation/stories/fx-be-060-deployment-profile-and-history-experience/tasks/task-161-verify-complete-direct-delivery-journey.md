---
type: Task
id: TASK-161
title: "Verify complete direct delivery journey"
status: planned
story: FX-BE-060
updated: 2026-09-07
dependencies: [TASK-160]
---

# TASK-161: Verify complete direct delivery journey

**Priority:** High
**Created:** 2026-09-07

## Goal

Exercise build/publish, prepared artifact review, deployment, failed health and rollback; update docs and parity matrix with implemented versus unavailable adapters.

## Implementation entry points

renderer/src/deployments (new); renderer/src/app; docs/user-guide.md. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-160
## Acceptance criteria

- Mock/scripted journeys run without production credentials; inspect light/dark and narrow viewport captures, keyboard flow and failure states.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
