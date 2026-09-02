---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-107
title: Run the full desktop suite and add designer/monitor visual snapshots
status: complete
story: FX-BE-023
updated: 2026-09-02
dependencies: [FX-BE-022]
validation: [npm run test:desktop]
---
## Run the full desktop suite and add designer/monitor visual snapshots
## Goal
Confirm the FX-BE-021/022 changes to the sidebar, App routing, preload, and the
core barrel did not move any existing behaviour or snapshot, and lock the new
surfaces with their own visual snapshots.
## Done when
- `npm run desktop:copy-renderer` then `npm run test:desktop` passes; any moved
  snapshot is regenerated and the PNG inspected.
- The designer (template library and an open workflow) and the run monitor each
  have a `toHaveScreenshot` assertion.
## Notes
The workflow specs already pass in isolation; this is the full-suite guard.

## Description


## Dependencies



## Comments


