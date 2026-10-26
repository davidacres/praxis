---
**Status:** 🔄 In Progress
**Created:** 2026-09-29T11:22:33.342Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-148
title: Budget-aware sequential runner and audit trail
status: In Progress
feature: FX-BF-047
updated: 2026-10-24
tasks: [TASK-385, TASK-386, TASK-463, TASK-464]
dependencies: [FX-BE-147, FX-BF-041]
validation: [npm run test:core, npm run test:desktop]
---

# Budget-aware sequential runner and audit trail

Parent feature folder: `fx-bf-047-scheduled-ticket-work-runs`

## User or operational impact

Scheduled work starts at the requested time and runs tickets one after another,
with clear pauses for budget limits, approvals, failures, and user decisions.

## Scope

- Start eligible schedules at or after their scheduled time after app launch or
  resume.
- Launch one queue entry at a time by connecting to the existing session and
  workflow-run machinery.
- Track queue-entry status, session links, artifacts, cost, token use, elapsed
  time, retry decisions, skips, and failure reasons.
- Pause before starting the next ticket when budget, allowance, approval, trust,
  or readiness policy requires user input.

## Acceptance criteria

- Sequential execution is the default for every scheduled run.
- A queue entry must reach a terminal, paused, or skipped state before the next
  entry starts.
- The run ledger explains every transition and includes links to created
  sessions or workflow runs.
- Budget and provider allowance checks run before each ticket, not only at the
  beginning of the schedule.
- At 95% of the active provider's allowance the runner records status, commits a
  checkpoint, and hands over to the next usable provider; with none left it pauses.
- Closing the app with a future schedule warns and recommends minimising.

## Task list

- `TASK-385` — Implement scheduled sequential execution.
- `TASK-386` — Add budget gates, pause states, and run ledger.
- `TASK-463` — Warn on close when a future schedule exists and recommend minimising.
- `TASK-464` — Hand over to the next provider at 95% of the active provider's allowance.

## Validation

- Core scheduler tests for due schedules, restart recovery, sequential ordering,
  and failure/skip behavior.
- Desktop E2E for scheduled start, first ticket completion, second ticket
  launch, pause, resume, and ledger review.

## Close when

A multi-ticket schedule can run sequentially from start time through completion
or pause, and the user can understand exactly what happened to every ticket.

## Description


## Dependencies



## Comments


**PRX-S47-148** — 2026-10-24T19:20:59.703Z
**Workflow run failed: Full SDLC — Budget-aware sequential runner and audit trail**

Status: Failed · Duration: 53m 54s

- ✅ Plan: succeeded
- ❌ Implement: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ Lint: pending
- ⏳ Type check: pending
- ⏳ Unit tests & coverage: pending
- ⏳ SAST scan: pending
- ⏳ Secret scan: pending
- ⏳ SCA scan: pending
- ⏳ Structured code review: pending
- ⏳ Deploy: pending

Required stage "implement" failed.

**PRX-S47-148** — 2026-10-24T19:23:24.304Z
**Workflow run failed: Full SDLC — Budget-aware sequential runner and audit trail**

Status: Failed · Duration: 2s

- ❌ Plan: failed
- ⏳ Implement: pending
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ Lint: pending
- ⏳ Type check: pending
- ⏳ Unit tests & coverage: pending
- ⏳ SAST scan: pending
- ⏳ Secret scan: pending
- ⏳ SCA scan: pending
- ⏳ Structured code review: pending
- ⏳ Deploy: pending

Required stage "plan" failed.

**PRX-S47-148** — 2026-10-24T22:22:41.323Z
**Workflow run cancelled: Full SDLC — Budget-aware sequential runner and audit trail**

Status: Cancelled · Duration: 1h 21m

- ✅ Plan: succeeded
- ❌ Implement: failed
- ⏭️ Install dependencies: cancelled
- ⏭️ Build: cancelled
- ⏭️ Lint: cancelled
- ⏭️ Type check: cancelled
- ⏭️ Unit tests & coverage: cancelled
- ⏭️ SAST scan: cancelled
- ⏭️ Secret scan: cancelled
- ⏭️ SCA scan: cancelled
- ⏭️ Structured code review: cancelled
- ⏭️ Deploy: cancelled

Deleted by the user.

**PRX-S47-148** — 2026-10-25T09:39:39.143Z
**Workflow run cancelled: Full SDLC — Budget-aware sequential runner and audit trail**

Status: Cancelled · Duration: 10h 38m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ❌ Lint: failed
- ❌ Type check: failed
- ❌ Unit tests & coverage: failed
- ❌ SAST scan: failed
- ❌ Secret scan: failed
- ❌ SCA scan: failed
- ✅ Structured code review: succeeded
- ⏭️ Deploy: cancelled

The scheduled run was stopped.

**PRX-S47-148** — 2026-10-25T20:21:37.334Z
**Workflow run succeeded: Governed delivery — Budget-aware sequential runner and audit trail**

Status: Succeeded · Duration: 10h 18m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ✅ QA: succeeded
- ✅ Security scan: succeeded

**PRX-S47-148** — 2026-10-25T20:33:48.440Z
**Workflow run cancelled: Full SDLC — Budget-aware sequential runner and audit trail**

Status: Cancelled · Duration: 22h 5m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ❌ Lint: failed
- ❌ Type check: failed
- ❌ Unit tests & coverage: failed
- ❌ SAST scan: failed
- ❌ Secret scan: failed
- ❌ SCA scan: failed
- ✅ Structured code review: succeeded
- ⏭️ Deploy: cancelled

Deleted by the user.
## Delivery status (2026-10-24)

The sequential runner and close warning are implemented and verified (TASK-385 and TASK-463 Done). Keep this story open for the ledger completeness and existing provider-handover-path gaps on TASK-386 and TASK-464. Runner unit tests and Electron checks prove queue order, recovery, budget pause and launch-failure/resume behavior, not full live-provider handover completion.

Implementation and verification evidence are recorded in the parent feature's Delivery status section (`FX-BF-047`, merge `f297b332`).
