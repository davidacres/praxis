---
type: Task
id: TASK-142
title: "Resolve launch configuration"
status: planned
story: FX-BE-054
updated: 2026-09-07
dependencies: [TASK-141]
---

# TASK-142: Resolve launch configuration

**Priority:** High
**Created:** 2026-09-07

## Goal

Inspect project manifests and .NET launch settings to propose editable commands; persist only after review and distinguish bind addresses from browser origins.

## Implementation entry points

packages/core/src/projects; packages/core/src/host/ipcContracts.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-141
## Acceptance criteria

- Fixtures cover Node frontend, ASP.NET API and multiple services; no detected script or launch settings file is executed during discovery.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
