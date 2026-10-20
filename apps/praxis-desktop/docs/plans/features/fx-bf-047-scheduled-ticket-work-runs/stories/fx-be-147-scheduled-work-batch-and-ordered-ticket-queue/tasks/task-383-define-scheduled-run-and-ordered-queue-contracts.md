---
**Status:** ✅ Done
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-383
title: Define scheduled run and ordered queue contracts
status: Done
story: FX-BE-147
updated: 2026-10-20
dependencies: []
validation: [npm run test:core]
---

# Define scheduled run and ordered queue contracts

## Goal

Create the durable data model for a scheduled work run, including start time,
timezone display, ticket queue entries, explicit ordering, readiness state, and
audit events.

## Done when

- The contract distinguishes the schedule definition from each execution
  attempt.
- Each queue entry has a stable id, ticket reference, sequence number, readiness
  state, and eventual run/session linkage.
- Serialization and migration tests cover empty, single-ticket, multi-ticket,
  reordered, and invalid-ticket schedules.
- A schedule is one-off: a single absolute start time plus a display timezone.
- A start that passed while Praxis was closed is the `missed` status, resolved only
  by an explicit start or skip.
- Readiness is derived from the live board each time the schedule is opened, never
  stored as authoritative.

## Notes

Keep ordering local to the schedule. Do not derive execution order from board
position or ticket status.

## Description


## Dependencies



## Comments

**2026-10-20:** Implemented in `packages/core/src/scheduledRuns/`: `scheduledRun.ts` (the definition, entries with a stable id and explicit `sequence`, `attempts` kept apart from the definition, an event log, and the pure operations including `composeScheduledRun`), `scheduledRunReadiness.ts` (derived, never stored), `scheduledRunTime.ts` (wall time <-> instant, with the DST gap returning no instant and the DST overlap taking the first occurrence), and `scheduledRunStore.ts` (a `KeyValueStore`-backed store whose `normalizeScheduledRun` is also the migration point). 38 tests cover empty, single, multi, reordered and invalid-ticket schedules, legacy-record repair, timezone round trips, and the missed-start rules.

Decisions made while building: a start-now resolution re-arms the schedule for the current instant rather than starting anything, so this layer stays side-effect free; a `projectId` is stored on the schedule so the lineup can show a project's own; readiness leaves `hasWorkflow` and non-folder-backed `hasFolder` unassessed rather than guessing, because a saved workflow is not needed to start a ticket and how a scheduled ticket chooses one belongs to TASK-385.
