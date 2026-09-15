---
**Status:** ✅ Complete
**Created:** 2026-09-15
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-332
title: "Add Bring in another AI, stop and tool-owner controls"
status: Complete
story: FX-BE-122
feature: FX-BF-035
updated: 2026-09-15
dependencies: [TASK-330, TASK-331]
---

# TASK-332: Add Bring in another AI, stop and tool-owner controls

## Objective

Give the composer an explicit, confirmable way to start a conversation, stop it,
and see who holds tools — without changing Hand over.

## Implementation notes

- Add **Bring in another AI** on the composer controls row beside Change model /
  Hand over. Disabled while a turn is running or a conversation is already
  running.
- Themed `.modal-card` dialog: guest provider/model, mode (consult / debate /
  pair), turn cap (small default, e.g. 6 total AI turns), copy that two models
  will spend. No `window.confirm`.
- While running, show both identities, turns used/cap, current speaker, tool
  owner, and **Stop conversation**. Stopping leaves follow-up with the host.
- Pair mode may offer promote/demote of tool owner between turns only.
- Surface-pack recipe on the new dialog shell. Do not add a backend-specific
  component; reuse existing form primitives.

## Acceptance criteria

- Hand over still opens the existing handover dialog and does not start a
  conversation.
- Bring in another AI requires confirmation and a guest distinct from a no-op.
- Stop returns the session to single-agent chat without deleting history.
- Controls are keyboard reachable and labelled.

## Verification

Extend `aiSessions.spec.ts` with stub providers; do not add this to the default
live suite. `npm run test:desktop` after `copy-renderer`.

## Description


## Dependencies


## Comments
