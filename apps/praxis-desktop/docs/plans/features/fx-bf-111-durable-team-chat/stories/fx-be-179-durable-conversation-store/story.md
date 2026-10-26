---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Story
**Priority:** High
id: FX-BE-179
type: Story
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
issue: docs/issues/features/fx-bf-111-durable-team-chat/stories/fx-be-179-durable-conversation-store/issue.md
---

# FX-BE-179: Durable conversation contracts and atomic storage

Parent: [FX-BF-111](../../feature.md). Issue mirror: [FX-BE-179](../../../../../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-179-durable-conversation-store/issue.md).

## User or operational impact

Accepted messages, reply results, and execution progress survive failures as one consistent conversation.

## Scope

- Extend assistantTypes.ts and agentTypes.ts with the versioned model in the feature design; introduce pure transition validation in core. Keep browser imports type-only. Define typed execution ownership without changing standalone session ownership.
- Evolve TeamChatStore behind a transaction repository contract; add a chat-specific desktop file adapter with clone-before-commit state and explicit corruption errors. Keep the existing profile-local team-chats.json storage location and avoid changing unrelated JsonKeyValueStore callers.

## Dependencies

None; existing assistant foundation

## Acceptance criteria

- 476: A duplicate submit command with identical payload resolves to the original turn; the same command ID with a different payload is rejected.
- 476: Transition tests reject a second running turn, stale revision writes, duplicate participant completion, and completion by a fenced attempt.
- 476: Types distinguish conversation ID, turn ID, participant ID, attempt ID, and optional provider session ID; no association requires parsing a title or diagnostic event.
- 477: Concurrent mutations across two chats and two windows retain every accepted change; one profile-wide writer serializes the shared snapshot.
- 477: Failure before rename leaves the old committed snapshot readable and emits no accepted acknowledgement; ambiguous failures after rename stop dispatch and require reload/reconciliation.
- 477: Submit commits user message, immutable response plan and command receipt together; completion commits final reply, attempt outcome and context boundary together.
- 477: Malformed existing JSON is surfaced as a recoverable storage error and is never replaced with an empty chat list.

## Tasks

- [TASK-476: Define typed conversation, turn, attempt, and binding contracts](tasks/task-476-conversation-contracts.md)
- [TASK-477: Implement serialized durable conversation transactions](tasks/task-477-atomic-chat-repository.md)

## Validation

Use the parent feature acceptance-to-suite mapping and validation commands. Each task supplies executable scenarios; record exact commands, assertion names and artifacts. This story does not close on typechecking alone.

## Close when

Both tasks satisfy every acceptance criterion, results are linked here and in the issue mirror, and no story-specific recovery or compatibility gap remains.

## Description


## Comments
