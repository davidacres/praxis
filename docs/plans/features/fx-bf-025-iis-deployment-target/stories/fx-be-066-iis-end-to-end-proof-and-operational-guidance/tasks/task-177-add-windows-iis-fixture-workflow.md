---
type: Task
id: TASK-177
title: "Add Windows IIS fixture workflow"
status: planned
story: FX-BE-066
updated: 2026-09-07
dependencies: [FX-BE-065]
---

# TASK-177: Add Windows IIS fixture workflow

**Priority:** High
**Created:** 2026-09-07

## Goal

Create opt-in disposable IIS setup and teardown for integration verification, with no production destination or credentials.

## Implementation entry points

docs/user-guide.md; deployment integration fixtures. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-065
## Acceptance criteria

- Fixture target is uniquely identified, cleanup only removes owned resources, and unsupported runners skip with an explicit reason.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
