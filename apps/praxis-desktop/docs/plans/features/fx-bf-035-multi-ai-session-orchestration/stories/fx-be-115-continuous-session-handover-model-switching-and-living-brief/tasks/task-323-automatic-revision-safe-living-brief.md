---
**Status:** ✅ Complete
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-323
title: "Refresh a revision-safe living brief after every completed turn"
status: Done
story: FX-BE-115
feature: FX-BF-035
updated: 2026-09-15
dependencies: [TASK-322]
---

# TASK-323: Refresh a revision-safe living brief after every completed turn

## Objective

Maintain a concise, portable account of the session after every completed
user-visible turn without polluting the transcript, losing user edits or claiming
stale information is current.

## Implementation notes

- Start the refresh only after the turn's required `message` event and durable
  tool/file events have been persisted. The next follow-up must continue to build
  its transcript from message events, not from the brief.
- Run summarization as an isolated, no-tools operation using the current
  provider/model. Do not append its prompt or answer to the visible conversation
  or mutate a provider-native conversation as though the user had sent another
  message.
- Send only the prior brief, events since its source position, current task list,
  purpose and bounded file/change evidence. Never grow the refresh prompt from an
  unbounded replay of the complete session.
- Serialize refreshes by session and commit them with an expected revision. Treat
  user-authored notes and edits as authoritative input that an automatic refresh
  cannot silently discard.
- Persist and display `updating`, `fresh`, `stale` and `failed` states. A refresh
  failure must not turn a successful agent turn into a failed turn, but it must
  retain the previous brief with an explicit error/freshness marker.

## Acceptance criteria

- Every completed turn schedules exactly one refresh after its message exists.
- Concurrent completion, editing and refresh operations cannot lose the newest
  revision or protected user content.
- A failed or unavailable summarizer leaves the last brief readable and visibly
  stale/failed.
- The summary operation never appears as a user/assistant transcript exchange.
- Tests prove bounded incremental input and ordering around message persistence.

## Verification

Run `npm run test:core`, the targeted API/ACP session host tests, and
`npm run check-types`.

## Description


## Dependencies


## Comments

