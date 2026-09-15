---
**Status:** ✅ Complete
**Created:** 2026-09-15
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-330
title: "Host bounded turn-taking between two providers in one session"
status: Complete
story: FX-BE-122
feature: FX-BF-035
updated: 2026-09-15
dependencies: [TASK-329, TASK-325]
---

# TASK-330: Host bounded turn-taking between two providers in one session

## Objective

Run two providers sequentially in the same Praxis session so each turn is a real
model call that sees the shared transcript, then yield to the other until the cap
or a stop.

## Implementation notes

- IPC starts a conversation with target provider/model, mode and cap. It does not
  go through `handoverSession`. Failed start leaves the host epoch in place.
- Each turn seeds the active provider with purpose, living brief, compacted
  transcript (including the other AI's last message as assistant, not user) and
  an instruction to address the other participant and the human.
- Native ACP/API runtime is per participant. Switching speakers starts or resumes
  that participant's runtime; it does not clear the other's portable history.
- Stop on: user stop, turn cap, tool-owner violation, provider failure, or a
  structured "done" from consult/debate if we add one later. Then the session is
  ordinary single-agent chat on the host (or last tool owner).
- Do not run both providers at once. Busy states still block Hand over / Change
  model.

## Acceptance criteria

- Two stub providers exchange N turns, then stop at the cap with N message events.
- The guest never appears as a user turn in the next host prompt.
- A failed guest turn does not drop the host session or invent a handover epoch.
- `handoverSession` still performs a one-shot relay with no conversation object.

## Verification

Core host tests with two scripted ACP/API stubs; `npm run test:core`.

## Description


## Dependencies


## Comments
