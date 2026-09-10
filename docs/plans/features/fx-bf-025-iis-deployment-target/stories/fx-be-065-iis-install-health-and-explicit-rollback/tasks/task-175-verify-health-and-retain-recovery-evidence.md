---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-175
title: "Verify health and retain recovery evidence"
status: To Do
story: FX-BE-065
updated: 2026-09-07
dependencies: [TASK-174]
---

# TASK-175: Verify health and retain recovery evidence

**Priority:** High
**Created:** 2026-09-07

## Goal

Run configured endpoint checks with bounded warmup and version evidence; retain deployment/backup identifiers and distinguish installation from service health.

## Implementation entry points

deployment executor scripts/templates; packages/core/src/deployments. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-174
## Acceptance criteria

- A responding endpoint with the wrong version fails verification; startup failure records logs and a usable recovery reference.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


