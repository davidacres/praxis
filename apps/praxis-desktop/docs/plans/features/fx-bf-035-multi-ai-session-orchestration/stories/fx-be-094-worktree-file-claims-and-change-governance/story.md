---
**Status:** ✅ Complete
**Created:** 2026-09-10T10:48:08.260Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-094
title: "Worktree, file claims and change governance"
status: Done
feature: FX-BF-035
updated: 2026-10-09
dependencies: [FX-BE-092, FX-BF-003]
---

# FX-BE-094: Worktree, file claims and change governance

## Outcome

Provider sessions are isolated, scoped and independently attributable.

## Tasks

- **TASK-262 Implement per-session branch and worktree creation, cleanup and dirty-worktree protection.**
- **TASK-263 Add path claims, overlap detection, expiry and release handling.**
- **TASK-264 Capture initial and final Git state, changed paths, diff statistics and out-of-scope changes.**
- **TASK-265 Implement merge-candidate preparation, conflict detection and safe recovery.**

## Acceptance

Two sessions cannot acquire overlapping write claims. An undeclared path change is blocked or escalated according to policy. A dirty worktree is never silently deleted. Every change set identifies session, task, source commit and final commit.

## Evidence

Contract tests, fixture repositories, captured provider output, failure and recovery tests, and visual or accessibility evidence where the story affects the desktop surface.

## Description


## Dependencies



## Comments



## Review 2026-09-25 — status corrected from To Do to In Progress

Substantially delivered through the session and workflow worktree work. Found
during the board review; the ticket was stale at To Do (updated 2026-09-10).

Delivered:

- `packages/core/src/git/gitWorktreeManager.ts` implements per-session branch
  and worktree creation and cleanup, with `gitWorktreeManager.test.ts` covering
  it and the e2e spec `aiWorktree.spec.ts` proving a worktree session creates
  the branch and checkout and can remove it (TASK-262).
- Dirty-worktree protection is enforced rather than assumed:
  `workflowWorkspace.ts` commits leftover changes as a WIP commit before
  removing a checkout because `--force` would throw them away, and
  `workflowMergeRunner.ts` refuses to merge into a checkout with uncommitted
  changes. `NewSession.tsx` surfaces uncommitted base files as a blocking
  choice instead of proceeding silently (TASK-262).
- Change attribution is captured: `runWork.ts` records commit count, commit
  list and uncommitted file count per worktree, and sessions carry
  `worktreePath`, `worktreeBranch`, `worktreeBaseBranch` and `worktreeName`
  so a change set resolves back to its session (TASK-264).

Not yet delivered, which is why this is In Progress rather than Done:

- TASK-263 is absent — there is no path-claim registry, no overlap detection
  between concurrent sessions, and no claim expiry or release. Isolation is
  currently by worktree only, so the acceptance criterion "two sessions cannot
  acquire overlapping write claims" is met incidentally rather than enforced.
- TASK-265's out-of-scope change policy (block or escalate an undeclared path
  change) has no implementation.

Remaining scope is TASK-263 and TASK-265.

## Review 2026-10-09 — remaining scope delivered, Done

- TASK-263: path claims are the FX-BF-048 coordination broker's `file` / `directory` /
  `worktree` claims (`packages/core/src/ai/coordination/`). Overlap is worktree-scoped
  (`resourcesOverlap`: a folder covers its descendants, different worktrees never collide,
  case-insensitive file systems handled). Claims expire — an unused reservation is dropped,
  an executing claim whose owner goes silent becomes `recovery-required` and is never
  handed over — and are released by their owner, at turn end, or by attributed recovery.
  Gateway writes and commands, ACP hosted writes and the in-app browser ask the broker
  before acting. "Two sessions cannot acquire overlapping write claims" is enforced, and a
  randomised 3,000-step test proves no two conflicting claims are ever held at once
  (shown to fail when conflict detection is broken).
- TASK-265: a merge stage can declare the paths a run was meant to change
  (`declaredPaths`) and a policy (`outOfScope: block | escalate`, default escalate).
  `runWorkflowMerge` checks the branch's changed paths with `assessChangeScope`: `block`
  holds the merge back naming the paths, `escalate` merges and reports each one as an
  `out-of-scope-change` finding. Evidence: `workflowMergeRunner.test.ts`,
  `workflowValidation.test.ts`, `coordination.test.ts`.
- End-to-end: `e2e/coordination.spec.ts` — a real ACP agent is refused a file another
  session holds (file untouched), the inspector shows the holder, a silent holder's claim
  waits for a person's recovery, and the fix then lands.
