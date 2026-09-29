---
**Status:** 📋 Proposed
**Created:** 2026-09-29T11:22:33.343Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-149
title: Optional bounded parallel lanes
status: Backlog
feature: FX-BF-047
updated: 2026-09-29
tasks: [TASK-387, TASK-388]
dependencies: [FX-BE-148]
validation: [npm run test:core, npm run test:desktop]
---

# Optional bounded parallel lanes

Parent feature folder: `fx-bf-047-scheduled-ticket-work-runs`

## User or operational impact

Power users can intentionally trade budget and focus for throughput when tickets
are independent, while the default path remains sequential and predictable.

## Scope

- Add an advanced run policy for bounded parallel lanes with an explicit maximum
  concurrency.
- Require dependency, readiness, and budget checks before launching more than one
  queue entry at a time.
- Display active lanes, estimated remaining budget, pause reasons, and the
  reason each ticket was allowed to run in parallel.

## Acceptance criteria

- Parallel execution is off by default and cannot be enabled accidentally.
- The user must choose a max concurrency greater than one and see a budget
  warning before saving or starting a parallel schedule.
- Tickets with dependencies, shared exclusive resources, blocked readiness, or
  uncertain budget remain sequential or paused.
- The ledger records parallel lane assignment and launch rationale for every
  concurrent ticket.

## Task list

- `TASK-387` — Define parallel dependency and safety policy.
- `TASK-388` — Add bounded lane controls and telemetry proof.

## Validation

- Core tests for dependency blocking, max-concurrency enforcement, and budget
  pause behavior.
- Desktop E2E for enabling parallel lanes, reviewing warnings, running two
  independent entries, and preventing unsafe concurrency.

## Close when

Parallel operation exists as a deliberate, capped, auditable mode that cannot
start dependent or under-budgeted work merely because there are idle lanes.

## Description


## Dependencies



## Comments


