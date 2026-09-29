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

## Done when

- The policy considers declared dependencies, shared resources, readiness,
  workflow gates, trust, provider allowance, and remaining budget.
- Max concurrency is stored on the scheduled run policy and defaults to one.
- Tests prove dependent or blocked tickets do not run concurrently.

## Notes

Parallelism is a scheduling policy, not a promise. The runner may use fewer
lanes than requested whenever safety or budget checks require it.

