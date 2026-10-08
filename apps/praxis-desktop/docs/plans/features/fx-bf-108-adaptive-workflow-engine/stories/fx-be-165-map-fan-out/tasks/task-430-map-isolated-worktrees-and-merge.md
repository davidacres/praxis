---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-430
slug: map-isolated-worktrees-and-merge
title: Per-item worktrees and deterministic merge-back
status: Done
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 165
---

# TASK-430: Per-item worktrees and deterministic merge-back

## Description

Give each mutating map child its own worktree and branch from the same snapshot, and merge results back in a deterministic order using the existing merge runner.

## Acceptance criteria

- Child branches are named from the run id and item (so release, inspect and delete flows find them) and releasing a child worktree never deletes its branch or discards uncommitted work.
- A merge conflict fails only that item, reports both sides, and can be retried or routed to a resolver stage.
- Cancelling the run stops every child and releases each worktree.
- A real-repository test (like `workflowInstallDeps.spec.ts`) fans out three edits, one conflicting, and checks the merged result and the failure report.

## Dependencies

- TASK-429

## Comments
