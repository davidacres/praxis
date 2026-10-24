---
**Status:** 📋 Proposed
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-387
title: Define parallel dependency and safety policy
status: Backlog
story: FX-BE-149
updated: 2026-09-29
dependencies: [TASK-386]
validation: [npm run test:core]
---

# Define parallel dependency and safety policy

## Goal

Define when scheduled ticket entries may run concurrently and when they must
remain sequential or paused.

## Acceptance criteria

- A scheduled run stores its maximum concurrency as a positive integer,
  defaults to one when no parallel policy is supplied, and rejects invalid
  values before dispatch.
- An entry can launch only after its declared dependencies have completed
  successfully; unresolved, failed, or incomplete dependencies block launch
  even when a lane is idle.
- Entries requiring the same exclusive resource cannot overlap. Independent
  entries may overlap only within the configured concurrency limit.
- Before every launch, the policy checks readiness, workflow approval gates,
  trust, provider allowance, and remaining budget. A failed or unknown check
  prevents that launch and produces a specific blocked or paused reason.
- Budget checks account for already active work; insufficient or uncertain
  remaining budget prevents another lane from starting.
- Core tests prove the sequential default, valid and invalid concurrency
  settings, dependency blocking, exclusive-resource conflicts, each launch
  gate, budget pauses, and enforcement of the cap across repeated dispatches.

## Notes

Parallelism is a scheduling policy, not a promise. The runner may use fewer
lanes than requested whenever safety or budget checks require it.

## Description


## Dependencies



## Comments

