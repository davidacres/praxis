---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-182
title: "Define trusted adapter configuration"
status: planned
story: FX-BE-067
updated: 2026-09-07
dependencies: [TASK-181]
---

# TASK-182: Define trusted adapter configuration

**Priority:** High
**Created:** 2026-09-07

## Goal

Configure explicit executable/args and capability requirements, source-path mapping and secret references; reuse project Run profile inputs without equating Run with Debug.

## Implementation entry points

packages/core/src/debugging (new); main/src/main. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-181
## Acceptance criteria

- Unsupported runtime or adapter blocks preflight with a reason; workspace configuration cannot silently download or execute an untrusted adapter.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


