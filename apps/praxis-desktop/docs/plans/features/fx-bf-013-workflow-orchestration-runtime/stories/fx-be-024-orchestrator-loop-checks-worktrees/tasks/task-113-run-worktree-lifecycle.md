---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-113
title: Add the per-run git worktree lifecycle and frozen snapshots
status: Done
story: FX-BE-024
updated: 2026-09-02
dependencies: [TASK-111]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# TASK-113: Add the per-run git worktree lifecycle and frozen snapshots
## Add the per-run git worktree lifecycle and frozen snapshots
## Goal
Give a run one isolated worktree so mutating stages build on each other and
verification stages inspect a fixed snapshot rather than a moving tree.
## Done when
- On run start, a worktree is prepared off the project's current branch
  (`GitWorktreeManager`); its path is recorded on the run.
- A mutating agent stage commits on completion; the commit sha is the stage's
  `snapshotRef` (already threaded through the run reducer and stage session).
- Review, QA, and security run against that worktree at the nearest upstream
  `snapshotRef` (`findSnapshot`), not at whatever HEAD has moved to.
- The worktree is removed when the run settles or is cancelled; a project with
  no git repo fails the run at start with an actionable message.
- Restart recovery re-attaches to an existing run worktree rather than creating
  a second.
## Notes
`GitWorktreeManager.prepareDeliveryWorktree` / `removeDeliveryWorktree` already
exist and are used by the legacy delivery flow.

## Description


## Dependencies



## Comments


