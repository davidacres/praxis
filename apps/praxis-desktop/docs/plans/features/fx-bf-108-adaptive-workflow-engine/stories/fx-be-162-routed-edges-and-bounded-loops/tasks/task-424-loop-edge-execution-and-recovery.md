---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-424
slug: loop-edge-execution-and-recovery
title: Execute loop edges: rework, counters, join-before-loop and recovery
status: Done
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 162
---

# TASK-424: Execute loop edges: rework, counters, join-before-loop and recovery

## Description

In `workflowOrchestrator.ts`, when a loop edge's predicate fires after its parallel band has settled, call `reworkWorkflowRun` from the edge target, increment the edge's counter, and persist before launching, following the orchestrator's existing persist-before-launch and one-step-per-run invariants.

## Acceptance criteria

- A loop edge is never taken while a downstream stage of the target is still running; the loop waits for the join.
- The counter is incremented atomically with the rework in one persisted transition; a crash on either side of that write recovers to a state that neither skips nor duplicates an iteration (covered by a recovery test through `workflowRecovery.ts`).
- Rework clears the stale gate decisions and re-derives snapshots; downstream gate owners re-assess the new snapshot and none reports a stale verdict.
- Worktree reuse across iterations re-attaches the existing `WF-<run8>-<slug>` branch as `prepareDeliveryWorktree` already does.
- A run with loop edges terminates in at most the sum of their budgets (property test over generated graphs).
- `failureRecovery` keeps working unchanged; its tests are green.

## Dependencies

- TASK-423

## Comments
