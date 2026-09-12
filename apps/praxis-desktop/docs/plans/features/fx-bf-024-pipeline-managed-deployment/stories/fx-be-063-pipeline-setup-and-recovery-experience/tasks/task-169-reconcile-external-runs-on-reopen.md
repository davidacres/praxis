---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-169
title: "Reconcile external runs on reopen"
status: To Do
story: FX-BE-063
updated: 2026-09-07
dependencies: [TASK-168]
---

# TASK-169: Reconcile external runs on reopen

**Priority:** High
**Created:** 2026-09-07

## Goal

Fetch current status by persisted provider run ID; handle revoked credentials, deleted runs and unknown dispatch with explicit recovery actions.

## Implementation entry points

renderer/src/deployments; packages/core/src/workflows. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-168
## Acceptance criteria

- Closing Praxis does not cancel a remote pipeline; reopening observes the same run; cancel requested is separate from confirmed cancellation.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


