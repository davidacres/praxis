---
**Status:** ✅ Complete
**Created:** 2026-09-15
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-331
title: "Render each AI as a distinct speaker in the session chat"
status: Complete
story: FX-BE-122
feature: FX-BF-035
updated: 2026-09-15
dependencies: [TASK-329, FX-BF-015, FX-BF-017]
---

# TASK-331: Render each AI as a distinct speaker in the session chat

## Objective

Make it obvious in the session transcript which AI spoke, without looking like a
second human or a generic assistant blob.

## Implementation notes

- Chat bubbles stay assistant-aligned. Differentiate with a visible speaker label
  (provider + short model) and a stable per-participant token (e.g. a second
  `--tone-*` or a conversation-local colour from the theme ramp). Do not reuse
  the tour magenta or steal the sole meaning of `--accent`.
- Never render an AI turn as `.session-chat-user`. The human remains the only
  right-aligned speaker.
- Streaming output for the active speaker uses the same identity chrome as the
  finished message.
- Inspector runtime history continues to list epochs; conversation participants
  may appear there as a compact pair, not a second transcript.
- Identity icons sit on the themed surface, not in decorative tiles. Components
  read tokens only.

## Acceptance criteria

- Two AI speakers are distinguishable in light and dark themes and with an active
  surface pack, including when colour is not the only cue (label remains).
- A user message cannot be confused with either AI.
- Keyboard focus rings remain visible on transcript controls.

## Verification

Desktop e2e on the session chat with stubbed conversation events; inspect
screenshots before accepting snapshots. `e2e/keyboardFocus.spec.ts` still passes.

## Description


## Dependencies


## Comments
