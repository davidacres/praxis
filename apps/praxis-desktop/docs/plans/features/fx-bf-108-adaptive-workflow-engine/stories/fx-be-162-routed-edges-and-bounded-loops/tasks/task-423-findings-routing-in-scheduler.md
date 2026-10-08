---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-423
slug: findings-routing-in-scheduler
title: Route on findings in the scheduler and share the severity counter
status: Done
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 162
---

# TASK-423: Route on findings in the scheduler and share the severity counter

## Description

Teach `evaluate` in `workflowScheduler.ts` to resolve a findings edge against its source stage's recorded findings, and factor the severity/metric counting out of `workflowGates.ts` into one shared function used by both gates and edges.

## Acceptance criteria

- Gates behave identically after the refactor (existing gate tests unchanged and green).
- When several outgoing edges match, the first in definition order is taken and the decision (edge id and predicate) is recorded on the run timeline.
- A source stage with no findings, a paused stage, or a stale snapshot never satisfies a findings edge.
- Edges not taken leave their targets `dead` and the existing skip handling settles them, so an untaken branch does not leave a finished run at `running`.
- Scheduler tests cover predicate hit, miss, ties, absent findings and parallel sources into a join.

## Dependencies

- TASK-422

## Comments
