---
type: Task
id: TASK-173
title: "Build IIS profile template"
status: planned
story: FX-BE-064
updated: 2026-09-07
dependencies: [TASK-172]
---

# TASK-173: Build IIS profile template

**Priority:** High
**Created:** 2026-09-07

## Goal

Use generic deployment forms with an IIS-specific configuration section; support local direct executor and an existing pipeline executor.

## Implementation entry points

packages/core/src/deployments; main/src/main; renderer/src/deployments. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-172
## Acceptance criteria

- An existing IIS test site can be selected explicitly; no site is created, deleted or rebound implicitly.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
