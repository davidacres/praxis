---
**Status:** ✅ Complete
**Created:** 2026-09-01T19:20:12.663Z
**Type:** Task
**Priority:** Medium
id: TASK-097
title: Add workflow retry and recovery controls
status: complete
story: FX-BE-019
updated: 2026-09-02
dependencies: [TASK-095, TASK-096]
validation: [npm run build:core, npm run test:core, npm run build:desktop]
---

# TASK-097: Add workflow retry and recovery controls
## Add workflow retry and recovery controls
## Goal
Implement bounded timeout, retry, cancellation, and restart recovery behavior in core and Electron main.
## Done when
- Completed nodes are not duplicated after restart.
- Failed, cancelled, and awaiting-input states expose an explicit next action.

## Description


## Dependencies



## Comments


