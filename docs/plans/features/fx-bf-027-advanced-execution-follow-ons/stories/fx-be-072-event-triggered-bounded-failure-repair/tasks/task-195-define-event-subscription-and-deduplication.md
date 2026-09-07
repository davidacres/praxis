---
type: Task
id: TASK-195
title: "Define event subscription and deduplication"
status: backlog
story: FX-BE-072
updated: 2026-09-07
dependencies: [FX-BE-071]
---

# TASK-195: Define event subscription and deduplication

**Priority:** Low
**Created:** 2026-09-07

## Goal

Scope triggers to project/repository/event type; persist delivery IDs and source SHA; choose an explicit always-on service or desktop-active polling mode.

## Implementation entry points

packages/core/src/workflows; CI provider adapters. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-071
## Acceptance criteria

- Duplicate and out-of-order events produce one intended repair; UI states when desktop closure stops monitoring.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
