---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-200
title: "Record rollout decision and remaining work"
status: backlog
story: FX-BE-073
updated: 2026-09-07
dependencies: [TASK-199]
---

# TASK-200: Record rollout decision and remaining work

**Priority:** Low
**Created:** 2026-09-07

## Goal

Write a go/no-go decision with measured prototype evidence and separate implementation backlog if approved.

## Implementation entry points

packages/core/src/deployments; architecture documentation. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-199
## Acceptance criteria

- Existing local and CI paths remain sufficient and supported; remote production support is not advertised from a prototype.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


