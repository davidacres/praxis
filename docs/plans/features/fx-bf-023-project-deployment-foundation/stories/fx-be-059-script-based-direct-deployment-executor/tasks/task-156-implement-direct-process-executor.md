---
type: Task
id: TASK-156
title: "Implement direct process executor"
status: planned
story: FX-BE-059
updated: 2026-09-07
dependencies: [FX-BE-058]
---

# TASK-156: Implement direct process executor

**Priority:** High
**Created:** 2026-09-07

## Goal

Spawn configured executable and argument arrays with scoped cwd/environment, cancellation and timeouts; pass artifact/target inputs without command-string interpolation.

## Implementation entry points

main/src/main; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-058
## Acceptance criteria

- Paths with spaces and metacharacters are data; fixture scripts produce typed results; startup failure and timeout preserve logs and operation identity.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
