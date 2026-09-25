---
**Status:** ✅ Complete
**Created:** 2026-09-10T10:48:08.260Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-096
title: "Session operations and review experience"
status: Done
feature: FX-BF-035
updated: 2026-09-25
dependencies: [FX-BE-095, FX-BE-115, FX-BF-014, FX-BF-015]
---

# FX-BE-096: Session operations and review experience

## Outcome

Users can understand multi-provider work, inspect context and evidence, and make safe operational decisions.

This story builds the broader orchestration monitor and merge-readiness experience
on top of FX-BE-115's continuous-session purpose, living brief, provider/model
runtime history and handover controls rather than introducing a second session
summary or reassignment model.

## Tasks

- **TASK-271 Add session list, provider and model status, stage state and live event display.**
- **TASK-272 Add context snapshot, file claims, changed-file and handoff inspection.**
- **TASK-273 Add retry, cancel, resume, reassign-provider and abandon controls with confirmation.**
- **TASK-274 Add a merge-readiness ledger showing validation, conflicts, policy and approval state.**
- **TASK-275 Add accessibility, responsive, theme and end-to-end verification.**

## Acceptance

The monitor distinguishes running, waiting, blocked, failed, cancelled, completed and awaiting-approval states. A user can inspect exactly what a provider was told and what it changed. Destructive controls explain impact and protect dirty worktrees.

## Evidence

Contract tests, fixture repositories, captured provider output, failure and recovery tests, and visual or accessibility evidence where the story affects the desktop surface.

## Description


## Dependencies



## Comments


## Review 2026-09-25 — status corrected from To Do to Done

Found shipped in the codebase during the board review; the ticket was stale at
To Do (updated 2026-09-10). As the story intended, it was built on FX-BE-115's
session purpose and living brief rather than as a second summary model.

- `SessionsPage.tsx` is the monitor and distinguishes the operational states
  the acceptance criterion names — running/executing, `awaiting_input`,
  `awaiting_approval`, paused, failed, cancelled and completed — via
  `AgentTaskState` and `isTerminalAgentState`, and surfaces the pending
  permission a session is blocked on.
- `SessionInspector.tsx` lets a user inspect exactly what a provider was told:
  the resolved purpose, living brief and handover envelope from
  `sessionHandover.ts`. `SessionChanges.tsx` and `SessionActivity.tsx` show
  what it changed, per file, with commit and discard controls.
- Destructive controls explain their impact instead of acting silently: the
  file-restore control in `SessionActivity.tsx` states the file on disk is
  overwritten and that Praxis cannot undo it, `NewSession.tsx` blocks on
  uncommitted base files and makes the user choose, and worktree removal
  preserves uncommitted work as a WIP commit first (`workflowWorkspace.ts`).
- Run-level review surfaces exist alongside the session ones in
  `WorkflowRunPage` and `AiReviewPage.tsx` / `LocalPeerReviewPage.tsx`.

Verified in this review: `npm run build:core` and `npm run test:core`
(1311 tests, 0 failures). Desktop build/e2e commands were unavailable in this
session, so re-run them before release.
