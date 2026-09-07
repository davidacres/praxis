---
type: Task
id: TASK-145
title: "Add explicit preview origin grants"
status: planned
story: FX-BE-055
updated: 2026-09-07
dependencies: [TASK-144]
---

# TASK-145: Add explicit preview origin grants

**Priority:** High
**Created:** 2026-09-07

## Goal

Bind allowed loopback origins to project and run identity; enforce redirect and subresource policy; preserve default private-host restrictions outside granted previews.

## Implementation entry points

main/src/main/terminalManager.ts; main/src/main/aiBrowser.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-144
## Acceptance criteria

- A granted localhost port opens; another project or port, redirected private host and unapproved private subresource remain blocked; revoke on run closure.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
