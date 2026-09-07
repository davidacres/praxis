---
type: Task
id: TASK-152
title: "Separate publish from deploy"
status: planned
story: FX-BE-057
updated: 2026-09-07
dependencies: [TASK-151]
---

# TASK-152: Separate publish from deploy

**Priority:** High
**Created:** 2026-09-07

## Goal

Define publish result manifests and digest validation; reference a built artifact for deployment/promotion instead of rebuilding; replace MSI-only assumptions through explicit conversion guidance.

## Implementation entry points

packages/core/src/projects; packages/core/src/workflows; packages/core/src/host/secrets.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-151
## Acceptance criteria

- A .NET publish directory and a web artifact both validate; absent or modified artifacts fail; existing MSI configuration remains understandable and is never silently reinterpreted.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
