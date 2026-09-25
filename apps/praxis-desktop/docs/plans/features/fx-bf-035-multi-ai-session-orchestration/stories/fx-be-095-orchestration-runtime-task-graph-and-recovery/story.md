---
**Status:** ✅ Complete
**Created:** 2026-09-10T10:48:08.260Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-095
title: "Orchestration runtime, task graph and recovery"
status: Done
feature: FX-BF-035
updated: 2026-09-25
dependencies: [FX-BE-093, FX-BE-094, FX-BF-013]
---

# FX-BE-095: Orchestration runtime, task graph and recovery

## Outcome

Praxis dispatches dependency-ready stages, joins results and recovers safely from agent or host failures.

## Tasks

- **TASK-266 Implement a dependency-aware scheduler with bounded parallelism and durable run state.**
- **TASK-267 Add an append-only session event log with redaction and correlation identifiers.**
- **TASK-268 Implement timeout, cancellation, retry, resume and escalation policies.**
- **TASK-269 Add stage joins, validation execution and handoff gating.**
- **TASK-270 Add a deterministic stub-agent end-to-end workflow.**

## Acceptance

A workflow executes design, implementation, independent review and validation in order, while independent tasks may run in parallel. Restarting the host resumes durable state without duplicating completed stages. Failed validation prevents merge readiness.

## Evidence

Contract tests, fixture repositories, captured provider output, failure and recovery tests, and visual or accessibility evidence where the story affects the desktop surface.

## Description


## Dependencies



## Comments



## Review 2026-09-25 — status corrected from To Do to Done

Found shipped in the codebase during the board review; the ticket was stale at
To Do (updated 2026-09-10). The runtime landed as the governed workflow engine
under FX-BF-040 rather than as a separate orchestrator.

- `packages/core/src/workflows/workflowScheduler.ts` implements the
  dependency-aware scheduler: `scheduleWorkflowRun` dispatches only
  dependency-ready nodes so independent stages run in parallel, `advanceJoins`
  joins their results, and `deriveRunStatus` folds node outcomes into the run
  status (TASK-266).
- Run state is durable and append-only. `workflowRun.ts` defines
  `WorkflowRunStatus` (`running | awaiting-approval | succeeded | failed |
  cancelled`) and a `WorkflowRunEventKind` event log including `node-retried`,
  `node-timed-out`, `node-interrupted`, `node-cancelled` and `node-reworked`,
  persisted through the run store so restarting the host resumes without
  re-running completed stages (TASK-267, TASK-268).
- Timeout, cancellation and retry policy live in `workflowOrchestrator.ts`
  (`cancelStage`, pause reasons, retry handling), with recovery proven by the
  restart-persistence coverage recorded on FX-BE-123 and FX-BE-128.
- Merge readiness is gated on validation: `workflowMergeRunner.ts` refuses to
  merge when checks have not passed or the target checkout is dirty, and
  `workflowGates.ts` holds the approval gate.
- Covered by `workflowOrchestrator.test.ts`, `workflowRun.test.ts` and
  `workflowValidation.test.ts`.

Verified in this review: `npm run build:core` and `npm run test:core`
(1311 tests, 0 failures). Desktop build/e2e commands were unavailable in this
session, so re-run them before release.
