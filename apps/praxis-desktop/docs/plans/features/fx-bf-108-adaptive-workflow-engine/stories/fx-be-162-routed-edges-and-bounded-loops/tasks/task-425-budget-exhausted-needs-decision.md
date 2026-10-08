---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-425
slug: budget-exhausted-needs-decision
title: Needs-decision state when a loop budget is spent
status: Backlog
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 162
---

# TASK-425: Needs-decision state when a loop budget is spent

## Description

When a loop's budget is spent and its predicate still holds, move the run to a needs-decision state instead of failing or continuing. Offer three recorded actions: approve anyway (actor and reason required), grant more iterations (bounded by the ceiling, recorded), or stop the run.

## Acceptance criteria

- The state is a first-class run status/pause reason handled by `isRunSettled`, the scheduler's stall reporting, the run summary and recovery, not a special-case failure.
- Each action is an IPC command that records who and why, in the manner of `bypassGate` / `rejectStage`; a delivery approval still cannot be skipped by any of them.
- The decision lists the open findings, iteration history and the stage that would run next.
- Cancelling or deleting a run in this state releases the worktree and preserves work as in any other state.
- Tests: each action's resulting run state, a restart while waiting, and that grant-more cannot exceed the ceiling.

## Dependencies

- TASK-424

## Comments
