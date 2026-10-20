---
**Status:** 📋 Proposed
**Created:** 2026-10-20T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-465
title: Build the live processor run view
status: Backlog
story: FX-BE-173
updated: 2026-10-20
dependencies: [TASK-385, TASK-386]
validation: [npm run check-types, npm run build:renderer, npm run test:desktop]
---

# Build the live processor run view

## Goal

Show a running schedule as a belt, a processor and a Done tray, driven by real runner state.

## Done when

- Queue entries, current stage, progress, gate and budget come from the run ledger.
- The processor stops and turns amber at an approval gate and shows the approve control.
- Reduced-motion users get the same information without movement.

## Notes

See `scheduled-runs-v2/3-live-run.html` for the target layout and motion.

## Description


## Dependencies


## Comments

