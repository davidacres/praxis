---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-196
title: "Apply automation limits and approval boundaries"
status: backlog
story: FX-BE-072
updated: 2026-09-07
dependencies: [TASK-195]
---

# TASK-196: Apply automation limits and approval boundaries

**Priority:** Low
**Created:** 2026-09-07

## Goal

Set attempt/time/concurrency limits and allowed repositories/actions; do not convert deployment approval into blanket future permission.

## Implementation entry points

packages/core/src/workflows; CI provider adapters. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-195
## Acceptance criteria

- Runaway repeated failures stop with a reason; new source revisions cannot reuse old approvals; unsupported spend enforcement remains explicitly advisory.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


