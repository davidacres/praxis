---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-118
title: Add the timeout enforcement tick
status: Done
story: FX-BE-026
updated: 2026-09-02
dependencies: [TASK-111]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# TASK-118: Add the timeout enforcement tick
## Add the timeout enforcement tick
## Goal
A stage that hangs must not hang the run.
## Done when
- While any run has a running stage, a periodic check calls
  `findTimedOutNodes(run, now)`; for each hit the orchestrator kills the stage's
  session or process and applies `node-timed-out`.
- The tick stops when no run has a running stage; it survives a restart
  (recovery re-arms it for non-settled runs).
- A timed-out stage is offered for retry within its attempt budget, per the
  engine.
- Core covers `findTimedOutNodes` boundary behaviour (already partly tested);
  a desktop test drives a stage with a tiny `timeoutMs` to a timed-out state.
## Notes
`findTimedOutNodes` exists in `workflowRecovery.ts`; nothing calls it yet.

## Description


## Dependencies



## Comments


