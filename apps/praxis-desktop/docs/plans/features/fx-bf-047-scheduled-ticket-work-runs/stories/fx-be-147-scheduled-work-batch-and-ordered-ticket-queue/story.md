---
type: Story
id: FX-BE-147
title: Scheduled work batch and ordered ticket queue
status: Backlog
feature: FX-BF-047
updated: 2026-09-29
tasks: [TASK-383, TASK-384]
dependencies: [FX-BF-040]
validation: [npm run test:core, npm run test:desktop]
---

# Scheduled work batch and ordered ticket queue

Parent feature folder: `fx-bf-047-scheduled-ticket-work-runs`

## User or operational impact

Users can prepare a batch of ticket work in advance, set the start time, and
decide the exact sequence in which Praxis should attempt the tickets.

## Scope

- Define the durable schedule, queue-entry, ordering, timezone, and readiness
  contracts.
- Add a scheduling surface that supports ticket selection, remove/reorder
  actions, scheduled start time, and review before save.
- Show schedule readiness, invalid tickets, missing workflow bindings, and
  policy blockers before the schedule can start.

## Acceptance criteria

- A schedule stores one or more ticket references, each with a stable queue id
  and explicit sequence position.
- The user can reorder tickets without mutating the underlying board order.
- The schedule stores an absolute start time and displays it in the selected or
  current timezone.
- A schedule with deleted, inaccessible, or blocked tickets remains visible and
  explains what must be fixed before launch.

## Task list

- `TASK-383` — Define scheduled run and ordered queue contracts.
- `TASK-384` — Build ticket picker, start-time, and order editor.

## Validation

- Core tests for schedule serialization, migration, ordering, and timezone
  round trips.
- Desktop E2E for create schedule, reorder tickets, save, reopen, and edit.

## Close when

A saved schedule can be reopened with the same start time, ticket list, running
order, and readiness state after an app restart.

