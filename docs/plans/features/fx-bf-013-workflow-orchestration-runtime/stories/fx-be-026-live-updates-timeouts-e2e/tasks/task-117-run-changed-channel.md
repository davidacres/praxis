---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-117
title: Add the workflows:runChanged push channel and monitor subscription
status: complete
story: FX-BE-026
updated: 2026-09-02
dependencies: [TASK-111]
validation: [npm run build:renderer, npm run build:desktop, npm run test:desktop]
---
## Add the workflows:runChanged push channel and monitor subscription
## Goal
The monitor must reflect a run the orchestrator advances in the background,
without the user clicking anything.
## Done when
- Every persisted run transition emits `workflows:runChanged` with the run id to
  all windows (pattern: `ai:reviewProgress`).
- `WorkflowsIpc` gains `onRunChanged(cb)` in preload; the monitor subscribes and
  refetches the affected run's summary, keeping the current selection.
- The subscription is disposed on unmount; a burst of transitions coalesces to
  one refetch.
## Notes
Renderer stays type-only against `@praxis/core`. Keep the payload minimal (id
only) and let the renderer pull the summary.

## Description


## Dependencies



## Comments


