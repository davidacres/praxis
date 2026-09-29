---
**Status:** 📋 Proposed
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-383
title: Define scheduled run and ordered queue contracts
status: Backlog
story: FX-BE-147
updated: 2026-09-29
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

## Notes

Keep ordering local to the schedule. Do not derive execution order from board
position or ticket status.

## Description


## Dependencies



## Comments


