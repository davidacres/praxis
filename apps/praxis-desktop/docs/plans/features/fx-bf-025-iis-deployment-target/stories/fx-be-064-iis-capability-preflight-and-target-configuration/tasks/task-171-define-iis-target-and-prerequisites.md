---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-171
title: "Define IIS target and prerequisites"
status: To Do
story: FX-BE-064
updated: 2026-09-07
dependencies: [FX-BF-023]
---

# TASK-171: Define IIS target and prerequisites

**Priority:** High
**Created:** 2026-09-07

## Goal

Record existing site/application/pool, deployment method, destination and health probe; detect Windows executor, IIS tooling and application runtime prerequisites.

## Implementation entry points

packages/core/src/deployments; main/src/main; renderer/src/deployments. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BF-023
## Acceptance criteria

- Non-Windows local execution yields a clear unsupported result while a pipeline-backed Windows target remains configurable; discovery makes no IIS mutations.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


