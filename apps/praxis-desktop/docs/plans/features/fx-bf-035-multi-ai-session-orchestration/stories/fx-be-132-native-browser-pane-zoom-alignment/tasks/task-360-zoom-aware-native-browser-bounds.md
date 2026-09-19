---
**Status:** ✅ Complete
**Created:** 2026-09-20
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-360
title: "Apply and verify zoom-aware native browser bounds"
status: Complete
story: FX-BE-132
feature: FX-BF-035
updated: 2026-09-20
dependencies: [FX-BE-096]
---

# TASK-360: Apply and verify zoom-aware native browser bounds

## Completed work

- Multiplied renderer-measured bounds by `webContents.getZoomFactor()` before
  applying them to native `WebContentsView` instances in the AI browser and
  project preview paths.
- Ran the focused browser e2e coverage and real screen-pixel checks at 100% and
  150% zoom.

## Verification

Main typecheck, focused browser tests, and retained 100%/150% screenshots passed.
**Complete.**

## Description


## Dependencies



## Comments


