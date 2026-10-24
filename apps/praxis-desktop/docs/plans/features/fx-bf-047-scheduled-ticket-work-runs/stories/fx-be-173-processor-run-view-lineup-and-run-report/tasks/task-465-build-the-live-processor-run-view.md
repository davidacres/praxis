---
**Status:** ✅ Done
**Created:** 2026-10-20T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-465
title: Build the live processor run view
status: Done
story: FX-BE-173
updated: 2026-10-24
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

## Delivery status (2026-10-24)

The live monitor reads the queue, stage/progress, gate and budget from scheduled-run views; pause/gate state stops the processor, shows the reason and exposes approval/decision controls. Reduced-motion CSS disables processor animations. Core tests cover approval gates; Electron tests verify budget and launch-failure pause views plus skip/resume, and their screenshots were visually inspected.

Implementation and verification evidence are recorded in the parent feature's Delivery status section (`FX-BF-047`, merge `f297b332`).
