---
**Status:** ✅ Complete
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-327
title: "Integrate every session entry point and preserve attribution and recovery"
status: Proposed
story: FX-BE-115
feature: FX-BF-035
updated: 2026-09-14
dependencies: [TASK-323, TASK-324, TASK-325, FX-BF-012, FX-BF-013]
---

# TASK-327: Integrate every session entry point and preserve attribution and recovery

## Objective

Ensure ordinary chat, analysis promotion, workflow-created sessions and resumed
API/ACP sessions all use the same purpose, brief and runtime-transition behavior
without duplicating provider-specific branches.

## Implementation notes

- Route `ai:delegate`, `ai:continueSession`, analysis promotion and workflow session
  creation through shared epoch, purpose and handover helpers.
- Preserve workflow run/node, delivery, agent/profile/host, active skills, board
  and worktree attribution through model changes and provider handovers.
- On application restart, retain completed epochs and the last brief; settle
  interrupted work using the existing aborted-session rule and mark an in-flight
  brief refresh stale rather than completed.
- Keep one persisted record per issue for this story. A handover must not create a
  competing issue-key record or make session navigation select an obsolete copy.
- Keep folder-backed project behavior unaffected and never point a test write path
  at this repository's real plans or Praxis metadata files.
- Centralize capability and transition errors so renderer, workflow monitor and
  direct session UI report the same blocked reason.

## Acceptance criteria

- Every supported session entry point creates a valid initial epoch and purpose.
- Analysis promotion and workflow continuation preserve the brief and epoch chain.
- Restart recovery cannot leave two open epochs or a permanently updating brief.
- Folder project regression counts and behavior remain unchanged.
- Provider/model transition rules are implemented once and shared by all callers.

## Verification

Run `npm run test:core`, the targeted workflow and folder desktop specs,
`npm run test:desktop:git`, and `npm run check-types`.

## Description


## Dependencies


## Comments

