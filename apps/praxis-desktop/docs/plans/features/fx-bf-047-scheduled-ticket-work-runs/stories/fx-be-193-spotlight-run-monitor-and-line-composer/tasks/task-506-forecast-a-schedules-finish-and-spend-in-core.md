---
**Status:** 📋 To Do
**Created:** 2026-11-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-506
title: Forecast a schedule's finish and spend in core
status: To Do
story: FX-BE-193
updated: 2026-11-02
dependencies: []
validation: [npm run check-types, npm run build:core, npm run test:core]
---

# Forecast a schedule's finish and spend in core

## Goal

One forecast that the composer's rehearsal and the monitor's "likely done" both
use, so the two screens never disagree.

## Done when

- `forecastScheduledRun(run, perEntryEstimate, now)` in
  `packages/core/src/scheduledRuns/` returns:
  - `likelyFinishAt` and `slowFinishAt`;
  - per entry: expected `startAt`/`endAt` and its lane;
  - `spend` as `{ likely, low, high, currency }` when estimable, otherwise
    `notEstimable` plus `basedOnSessions`.
- It applies the runner's own rules: steps in order, a step waits for every
  ticket before it, at most `maxConcurrency` tickets at once, and the same
  launch gap.
- For a running schedule it starts from what is recorded: finished entries use
  their real end, running entries use elapsed plus their remaining estimate,
  and paused time so far is included.
- `scheduledRuns.preview` returns the forecast with readiness, so the composer
  needs no new call. `ScheduledRunView` carries it for the monitor.
- Unit tests: sequential, 3 lanes with uneven steps, one entry already done,
  one entry running past its estimate, nothing estimable.

## Notes

- Per-entry estimates come from `estimateWorkflowRun(definition, { usage:
  stageUsageSample(...) })`. Fall back to the workflow's median per ticket when
  a ticket has no history.
- "Slow finish" means the high end of the estimate, not a statistical claim.
  Label it "could run to" in the UI.

## Dependencies


## Description


## Comments

