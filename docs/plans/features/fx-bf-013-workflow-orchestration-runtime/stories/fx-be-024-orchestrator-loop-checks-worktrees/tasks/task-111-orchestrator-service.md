---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-111
title: Add the WorkflowOrchestrator service and scheduler-driven dispatch
status: complete
story: FX-BE-024
updated: 2026-09-02
dependencies: [FX-BE-019]
validation: [npm run build, npm run test:core, npm run test:desktop]
---
## Add the WorkflowOrchestrator service and scheduler-driven dispatch
## Goal
The impure loop around the pure engine: watch a run, dispatch what is ready,
apply the outcome, re-schedule.
## Done when
- On a run transition the orchestrator calls `scheduleWorkflowRun`, advances
  converged joins (`advanceJoins`), and dispatches each `ready` node by kind
  (check → TASK-112; agent → FX-BE-025; approval → left for a human).
- Each dispatch result is applied as a `WorkflowRunCommand`, the run is
  persisted via `WorkflowRunStore` after every command, and the loop re-runs
  until `ready` and `running` are both empty.
- Dispatch is idempotent: a stage already `running` is never dispatched again,
  including after `recoverWorkflowRunsOnStartup`, which must re-enter the loop
  for every non-settled run.
- A cancelled or settled run stops the loop; the orchestrator holds no state the
  run record does not.
## Notes
Pure scheduling stays in `packages/core`; this service is main-process only.
Model it on `aiReviewRuntime` / the `ai:delegate` handler for host access.

## Description


## Dependencies



## Comments


