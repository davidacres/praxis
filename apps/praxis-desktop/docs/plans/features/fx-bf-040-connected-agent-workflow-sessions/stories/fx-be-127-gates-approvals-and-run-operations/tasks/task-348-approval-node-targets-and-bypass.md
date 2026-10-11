---
**Status:** Done
**Created:** 2026-09-17T21:33:43.733Z
**Type:** Task
**Priority:** Medium
id: TASK-348
title: Implement explicit approval and bypass target handling and policy checks
status: Done
story: FX-BE-127
updated: 2026-10-11
dependencies: [TASK-347]
validation: [npm run test:core, npm run test:desktop]
---

# Implement explicit approval and bypass target handling and policy checks

## Goal

Remove first-approval assumptions and make approval/bypass actions target the
exact approval node and gate the user is viewing.

## Done when

- IPC, scheduler, summary, and UI carry an approval-node/gate id explicitly.
- Multiple approval nodes can pause independently and resume the correct
  downstream branches.
- Bypass checks the composed policy, requires actor/reason, and records the
  target node and resulting decision.

## Notes

Definition-level gates and policy-level gates must remain distinguishable in
the ledger, even when their effective requirement is combined.

## Description


## Dependencies



## Comments

### 2026-10-11 — approved backlog closeout

Marked Done following the user-approved backlog review.

`resolveApprovalTarget` refuses ambiguous approval targets. Workflow IPC and preload carry the selected node id; `approveStage` and `bypassGate` enforce policy and record the actor, reason and target. Core tests cover multiple approvals and explicit target selection.

The preceding review passed root `npm run check-types` and 277 focused core tests
(runtime/session manager and workflow gates, stage tasks, validation, run,
orchestrator, store and summary). These are prior review results; no new build,
desktop E2E run or visual verification was performed for this status-only change.
