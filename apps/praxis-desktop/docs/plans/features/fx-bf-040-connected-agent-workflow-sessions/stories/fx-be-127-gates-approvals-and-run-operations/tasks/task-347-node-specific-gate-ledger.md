---
**Status:** Done
**Created:** 2026-09-17T21:33:43.732Z
**Type:** Task
**Priority:** Medium
id: TASK-347
title: Make gate outcomes and evidence node-specific and durable
status: Done
story: FX-BE-127
updated: 2026-10-11
dependencies: [TASK-341]
validation: [npm run test:core, npm run test:desktop]
---

# Make gate outcomes and evidence node-specific and durable

## Goal

Ensure each gate is satisfied only by the exact node outcome, required
artifacts, or deterministic check contract that owns it.

## Done when

- Gate ledger entries identify gate type, owning node, evidence, status, and
  policy source.
- Missing, stale, failed, and superseded evidence produce the correct blocked
  state and cannot be replaced by agent prose.
- Run summary, scheduler, and monitor read the same durable ledger.

## Notes

Retain audit history while presenting a concise normal-user digest in the
monitor and session inspector.

## Description


## Dependencies



## Comments

### 2026-10-11 — approved backlog closeout

Marked Done following the user-approved backlog review.

`packages/core/src/workflows/workflowGates.ts` evaluates the owning node and missing, failed or stale evidence against the current snapshot. Decisions persist in `workflowRun.ts`; `workflowRunSummary.ts` reads the same run state.

The preceding review passed root `npm run check-types` and 277 focused core tests
(runtime/session manager and workflow gates, stage tasks, validation, run,
orchestrator, store and summary). These are prior review results; no new build,
desktop E2E run or visual verification was performed for this status-only change.
