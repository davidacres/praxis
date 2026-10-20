---
**Status:** 📋 Proposed
**Created:** 2026-09-29T11:22:33.342Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-148
title: Budget-aware sequential runner and audit trail
status: Backlog
feature: FX-BF-047
updated: 2026-10-20
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

