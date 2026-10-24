---
**Status:** ✅ Done
**Created:** 2026-09-29T11:22:33.341Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-147
title: Scheduled work batch and ordered ticket queue
status: Done
feature: FX-BF-047
updated: 2026-10-24
tasks: [TASK-383, TASK-384, TASK-462]
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
- A schedule is a one-off: one absolute start time, no repeat rule.
- A schedule whose start passed while Praxis was closed is reported as missed,
  and only an explicit user choice starts it or skips it.
- Only board tickets can be queued; an existing session cannot.

## Task list

- `TASK-383` — Define scheduled run and ordered queue contracts.
- `TASK-384` — Build ticket picker, start-time, and order editor (the hopper and
  belt composer from the v2 design).
- `TASK-462` — Add the board entry points and the Scheduled runs lineup page.

## Validation

- Core tests for schedule serialization, migration, ordering, and timezone
  round trips.
- Desktop E2E for create schedule, reorder tickets, save, reopen, and edit.

## Close when

A saved schedule can be reopened with the same start time, ticket list, running
order, and readiness state after an app restart.

## Description


## Dependencies



## Comments

**2026-10-20:** TASK-383 and TASK-384 are done and TASK-462 is in progress (board selection bar outstanding). The close condition — a saved schedule reopened after an app restart with the same start time, ticket list and running order — is covered by `e2e/scheduledRuns.spec.ts`. Readiness is recomputed on every read, so a deleted or unreadable ticket stays visible with its reason. Nothing starts a schedule yet: that is FX-BE-148, and the whole surface stays behind the Scheduled runs preview until it does.

## Delivery status (2026-10-24)

Ordered schedules, board entry points, editing, persistence, timezone validation, missed-start decisions and readiness are implemented on main. TASK-383 and TASK-384 were already Done; TASK-462 is now Done. Verified by the scheduled-run core and Electron checks recorded below.

Implementation and verification evidence are recorded in the parent feature's Delivery status section (`FX-BF-047`, merge `f297b332`).
