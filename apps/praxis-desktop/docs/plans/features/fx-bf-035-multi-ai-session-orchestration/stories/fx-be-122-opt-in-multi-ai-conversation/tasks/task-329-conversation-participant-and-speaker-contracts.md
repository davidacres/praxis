---
**Status:** ✅ Complete
**Created:** 2026-09-15
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-329
title: "Add conversation, participant and speaker-attribution contracts"
status: Complete
story: FX-BE-122
feature: FX-BF-035
updated: 2026-09-15
dependencies: [FX-BE-115, FX-BE-092]
---

# TASK-329: Add conversation, participant and speaker-attribution contracts

## Objective

Give a session an explicit, persistable multi-AI conversation record that names
participants, mode, tool owner and turn cap without changing handover epochs.

## Implementation notes

- Add a conversation object on `AgentSessionRecord` (absent means single-agent).
  Fields: mode (`consult` | `debate` | `pair`), participants (provider, model,
  role host/guest, display label), current tool owner, turn cap, turns used,
  state (`idle` | `running` | `stopped` | `capped` | `failed`).
- Attribute every assistant `message` with speaker identity (participant id,
  provider, model). User turns remain the human. Never encode an AI as
  `user_input_completed`.
- Reuse runtime epochs for which provider is active on a turn; do not invent a
  second session id. Handover `provider_handover` stays the relay event.
- Persist and hydrate without breaking FX-BE-115 records that have no
  conversation object.
- Renderer must not value-import `@praxis/core`.

## Acceptance criteria

- Old sessions load with no conversation object and unchanged handover behaviour.
- A conversation record names two participants, a mode, a tool owner and a cap.
- Message events can be attributed to a participant without looking like the user.

## Verification

`npm run test:core` persistence/migration tests; `npm run check-types`.

## Description


## Dependencies


## Comments
