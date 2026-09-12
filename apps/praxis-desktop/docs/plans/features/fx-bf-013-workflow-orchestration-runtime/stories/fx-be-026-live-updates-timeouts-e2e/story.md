---
**Status:** 📋 Proposed
**Created:** 2026-09-02T00:54:54.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-026
title: Live updates, timeouts, and end-to-end verification
status: Done
feature: FX-BF-013
issue: docs/issues/features/fx-bf-013-workflow-orchestration-runtime/stories/fx-be-026-live-updates-timeouts-e2e/issue.md
updated: 2026-09-02
tasks: [TASK-117, TASK-118, TASK-119]
dependencies: [FX-BE-024, FX-BE-025]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# Live updates, timeouts, and end-to-end verification

## User or operational impact

The run monitor reflects a background run as it moves, stuck stages are bounded,
and the whole governed pipeline is verified end to end without a person clicking
each stage.

## Scope

- A `workflows:runChanged` push channel emitting the run id on every persisted
  transition; the monitor subscribes and refetches that run's summary.
- A timeout tick that checks running stages against their `timeoutMs`
  (`findTimedOutNodes`), kills the underlying session or process, and applies
  `node-timed-out`.
- Packaged desktop E2E driving the built-in template with a stub agent through
  template selection, parallel branch join, a failing gate, approval, restart
  recovery, and cancellation, plus updated documentation.

## Acceptance criteria

- Completing a stage in the background updates the monitor with no user action.
- A stage past its timeout is failed with a clear reason and offered for retry.
- The E2E completes an unattended run from a project task to approval, blocks on
  a failed required gate with actionable evidence, restores the monitor after a
  restart without re-running completed stages, and cancels cleanly.
- `docs/governed-delivery-workflows.md` reflects real (non-stubbed) execution.

## Task list

- `TASK-117` — Add the `workflows:runChanged` push channel and monitor subscription.
- `TASK-118` — Add the timeout enforcement tick.
- `TASK-119` — Add the unattended-run E2E with a stub agent, and update the docs.

## Close when

The built-in Governed delivery workflow runs from task to approval unattended in
a packaged desktop test, and the monitor stays live throughout.

## Description


## Dependencies



## Comments


