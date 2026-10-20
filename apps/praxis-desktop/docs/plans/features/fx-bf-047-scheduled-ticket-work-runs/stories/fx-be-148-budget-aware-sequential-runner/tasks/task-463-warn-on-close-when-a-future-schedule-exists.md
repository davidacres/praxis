---
**Status:** 📋 Proposed
**Created:** 2026-10-20T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-463
title: Warn on close when a future schedule exists and recommend minimising
status: Backlog
story: FX-BE-148
updated: 2026-10-20
dependencies: [TASK-383]
validation: [npm run test:desktop]
---

# Warn on close when a future schedule exists and recommend minimising

## Goal

A closed app cannot start a schedule, so closing it while one is pending should be a deliberate choice.

## Done when

- Closing the app (window close, quit) with at least one scheduled, not-yet-started
  run shows a confirmation naming the next start time.
- The confirmation recommends minimising and offers *Minimise*, *Quit anyway* and *Cancel*.
- With no pending schedule, closing behaves exactly as it does today.
- A schedule that is running or finished does not trigger the warning.

## Notes

Keep the check in main behind the existing close handling. It must not block quit when the user chose *Quit anyway*.

## Description


## Dependencies


## Comments

