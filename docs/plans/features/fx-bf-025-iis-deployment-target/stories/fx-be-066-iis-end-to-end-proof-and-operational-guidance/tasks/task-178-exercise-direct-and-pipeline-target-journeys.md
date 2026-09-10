---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-178
title: "Exercise direct and pipeline target journeys"
status: planned
story: FX-BE-066
updated: 2026-09-07
dependencies: [TASK-177]
---

# TASK-178: Exercise direct and pipeline target journeys

**Priority:** High
**Created:** 2026-09-07

## Goal

Use the same target contract for local direct deployment and a configured Windows CI runner; record source/digest and health evidence.

## Implementation entry points

docs/user-guide.md; deployment integration fixtures. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-177
## Acceptance criteria

- Both paths install the same fixture artifact and support their declared rollback path; ordinary app E2E uses mocks and never touches real IIS.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


