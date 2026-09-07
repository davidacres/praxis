---
type: Task
id: TASK-139
title: "Add failure selection and refresh"
status: planned
story: FX-BE-053
updated: 2026-09-07
dependencies: [TASK-138]
---

# TASK-139: Add failure selection and refresh

**Priority:** High
**Created:** 2026-09-07

## Goal

Offer failed run/job selection and import into the evidence store with cancellation, bounded downloads and visible freshness; preserve provider errors and source links.

## Implementation entry points

packages/core/src/github; packages/core/src/gitlab; renderer/src/workflows. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-138
## Acceptance criteria

- Selecting an older failed attempt never silently substitutes the latest attempt; retrying import does not duplicate the evidence bundle.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
