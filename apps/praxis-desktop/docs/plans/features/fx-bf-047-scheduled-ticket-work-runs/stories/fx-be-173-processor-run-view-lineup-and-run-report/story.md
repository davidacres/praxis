---
**Status:** 📋 Proposed
**Created:** 2026-10-20T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-173
title: Processor run view and run report
status: Backlog
feature: FX-BF-047
updated: 2026-10-20
tasks: [TASK-465, TASK-466]
dependencies: [FX-BE-148]
validation: [npm run check-types, npm run build:renderer, npm run test:desktop]
---

# Processor run view and run report

Parent feature folder: `fx-bf-047-scheduled-ticket-work-runs`

## User or operational impact

A user can watch a scheduled run work through its tickets one at a time, see
exactly where it is, act on an approval gate, and afterwards read what it did.

## Scope

- A live run view: a queue belt feeding a processor that shows the current
  ticket's stage and progress, an activity log, budget and a Done tray.
- A gate state that stops the processor and asks for the user's decision.
- A run report with spend, active time, artifacts, approvals and per-ticket stage
  timings.

## Acceptance criteria

- The live run view reflects the runner's real state; it never animates progress
  the runner has not reported.
- An approval gate stops the processor and shows who or what is waiting.
- Motion respects the reduced-motion setting.
- The report is readable without any animation.

## Task list

- `TASK-465` — Build the live run view.
- `TASK-466` — Build the run report.

## Validation

- Desktop E2E for a run progressing, pausing at a gate, and finishing, using the
  fake agent fixtures.

## Close when

A user can follow a scheduled run live and review it afterwards.

## Description


## Dependencies


## Comments

