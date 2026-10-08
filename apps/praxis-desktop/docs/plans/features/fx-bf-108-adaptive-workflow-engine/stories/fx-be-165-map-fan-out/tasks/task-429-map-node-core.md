---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-429
slug: map-node-core
title: Map node: type, validation, scheduling and aggregation
status: Backlog
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 165
---

# TASK-429: Map node: type, validation, scheduling and aggregation

## Description

Add the `map` node kind: list input, child stage template, concurrency cap, item cap and a `failFast` / `collect` policy. Implement scheduling, per-item run records and aggregation of outputs.

## Acceptance criteria

- Types, validation (list input exists, caps in range), normalizers and run-record shape cover the node and its items.
- Items beyond the cap are recorded as deferred and the run stops for a decision rather than dropping them.
- Aggregation concatenates findings deduplicated by fingerprint and exposes one output per declared contract.
- Per-item provider-limit pauses do not spend the item's attempt; partial failure follows the declared policy.
- A global concurrency cap bounds all map children across runs.
- Existing workflows are unaffected (a validation/run test with no map node is unchanged).

## Dependencies

- TASK-422

## Comments
