---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-246
title: "Add a bounded review to implement fix loop"
status: planned
story: FX-BE-089
updated: 2026-09-09
dependencies: [TASK-245]
---

# TASK-246: Add a bounded review to implement fix loop

**Priority:** Medium
**Created:** 2026-09-09

## Goal

When a review stage produces findings at or above a configured blocking severity, route back to a re-implement stage that is handed exactly those findings, within a per-run attempt budget, then re-review. The `review` gate cannot pass while blocking findings stand. Exhausting the budget fails the run with the outstanding findings listed. The re-implement produces a new snapshot, so QA and security re-run against it (they already inspect the frozen snapshot).

## Implementation entry points

packages/core/src/workflows (a `review → implement` edge with `on: 'failure'` semantics carrying the blocking findings, an attempt counter distinct from a node's `maxAttempts`, re-entry into the scheduler), workflowRun.ts (loop accounting and terminal reason), workflowTemplates.ts (wire the loop into `full-sdlc` in FX-BE-090; here just support it).

## Dependencies

- TASK-245
## Acceptance criteria

- A seeded blocking finding routes to re-implement with those findings in the brief; a clean re-review then passes `review`.
- The loop stops at the budget and the run fails with the outstanding blocking findings named; a non-blocking finding never triggers the loop.
- Re-implement commits a new snapshot and the downstream QA/security stages re-evaluate against it; no stale gate carries over.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows (templates without the loop edge are unaffected).

## Verification

Core tests for loop accounting (enter, budget exhaustion, clean exit) and for snapshot re-freeze on re-implement. Scripted agents for the end-to-end loop. `npm run test:core`, `npm run test:desktop:workflows`, `npm run check-types`. Prove the "blocking finding cannot pass the gate" and budget guards fail against the pre-change single-pass review. Never point a Praxis write path at the repository's own plans.

## Description


## Comments


