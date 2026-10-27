---
**Status:** ✅ Done
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-388
title: Add bounded lane controls and telemetry proof
status: Done
story: FX-BE-149
updated: 2026-10-27
dependencies: [TASK-387]
validation: [npm run check-types, npm run build:renderer, npm run test:desktop]
---

# Add bounded lane controls and telemetry proof

## Goal

Add the UI and evidence needed for users to enable, monitor, and trust bounded
parallel scheduled work.

## Acceptance criteria

- New schedules use sequential execution by default. Parallel lanes are an
  explicit advanced option, and enabling them requires choosing a maximum
  concurrency greater than one.
- The editor rejects invalid concurrency values and shows a budget warning
  before a parallel schedule can be saved or started. Reopening a saved
  schedule preserves the selected execution mode and concurrency limit.
- While a run is active, its view shows active lane assignments, queued work,
  blocked entries with reasons, run pause reasons, actual spend, and estimated
  remaining budget. Unavailable budget data is shown as unknown.
- Each concurrent launch has a persisted ledger entry identifying the ticket,
  lane, linked workflow run, and rationale for allowing parallel execution;
  the evidence remains available after reopening the run.
- Desktop E2E tests enable parallel mode, inspect the warning, save and reopen
  the schedule, and observe two independent entries running within the cap.
- Desktop E2E tests prove dependent or exclusive-resource-conflicting entries
  cannot overlap, blocked readiness and insufficient or unknown budget prevent
  unsafe starts, and the UI and ledger expose the corresponding reasons.

## Notes

Use parallel mode sparingly in copy and defaults. The product should nudge users
toward completion, not maximum simultaneous spend.

## Description


## Dependencies



## Comments

2026-10-27: Editor "Tickets at once" control (default one at a time) with a budget warning and a `parallel-lanes` readiness warning; the choice survives saving and reopening. The monitor's Lanes panel shows lanes, steps, recorded "why now" rationale, waiting reasons, spend and remaining allowance (unknown when unreported). Each concurrent launch persists `lane` and `laneReason` and an `entry-launching` ledger line. E2E proves: editor warning plus save and reopen; two independent entries running within a cap of 2 while a third waits and the next step waits; 80% and unreported allowance hold the second lane with the reason in the ledger. Still open: an e2e for two parallel merges taking turns (the lock is only unit-tested), and an overnight live-provider qualification.

2026-10-27 (closed): Added e2e proof that two parallel tickets merging into one base checkout take turns. The second merge ends at least one hold after the first, and with the lock bypassed they ended 108 ms apart and the test failed. A parallel run with blocked readiness (a dirty base) starts nothing in any lane and names the reason. The scheduled Electron suite has 31 passed and 1 opt-in skipped. `PRAXIS_E2E_MERGE_HOLD_MS` is the test-only hold inside the merge lock. Not claimed: an overnight live-provider run.
