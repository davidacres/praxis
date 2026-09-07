---
type: Task
id: TASK-157
title: "Add local directory target and health verification"
status: planned
story: FX-BE-059
updated: 2026-09-07
dependencies: [TASK-156]
---

# TASK-157: Add local directory target and health verification

**Priority:** High
**Created:** 2026-09-07

## Goal

Implement a template for a persistent local web root with staging, backup/restore and configured post-install health check; distinguish application content from mutable data.

## Implementation entry points

main/src/main; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-156
## Acceptance criteria

- A fixture web root updates from one immutable artifact, excludes configured user data, fails on bad health and can restore the previous version.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
