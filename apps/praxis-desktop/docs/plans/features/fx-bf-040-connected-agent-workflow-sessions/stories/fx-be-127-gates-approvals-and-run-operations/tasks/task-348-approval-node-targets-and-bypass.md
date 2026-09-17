---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.733Z
**Type:** Task
**Priority:** Medium
id: TASK-348
title: Implement explicit approval and bypass target handling and policy checks
status: Planned
story: FX-BE-127
updated: 2026-09-17
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
