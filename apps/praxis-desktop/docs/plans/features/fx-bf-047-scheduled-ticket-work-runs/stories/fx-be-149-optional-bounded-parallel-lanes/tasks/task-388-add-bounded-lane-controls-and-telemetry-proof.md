---
**Status:** 📋 Proposed
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-388
title: Add bounded lane controls and telemetry proof
status: Backlog
story: FX-BE-149
updated: 2026-09-29
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

