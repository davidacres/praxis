---
**Status:** ✅ Done
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-385
title: Implement scheduled sequential execution
status: Done
story: FX-BE-148
updated: 2026-10-24
dependencies: [TASK-383, TASK-384]
validation: [npm run test:core, npm run test:desktop]
---

# Implement scheduled sequential execution

## Goal

Run due schedules through a deterministic sequential queue where only one ticket
entry is active by default.

## Done when

- Due schedules are discovered after app start and resume without duplicate
  launches.
- The runner starts the first ready queue entry and waits for a terminal,
  paused, or skipped state before considering the next entry.
- Restart recovery resumes or reconciles active schedule attempts without losing
  queue order.

## Notes

Use the existing session and governed workflow execution paths. The scheduler
should coordinate work, not become a separate automation runtime.

## Description


## Dependencies



## Comments

## Delivery status (2026-10-24)

The runner discovers due schedules while enabled, launches one queue entry at a time through the workflow engine, persists launch tokens before launch, and reconciles interrupted starts without duplicate launches. Scheduled-run core tests cover sequential ordering, missed starts, crash recovery and workflow-event serialization; Electron checks cover due starts and pause/skip/resume after a dirty-base launch refusal.

Implementation and verification evidence are recorded in the parent feature's Delivery status section (`FX-BF-047`, merge `f297b332`).
