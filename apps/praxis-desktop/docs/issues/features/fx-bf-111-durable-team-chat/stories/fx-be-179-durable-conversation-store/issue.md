# FX-BE-179: Durable conversation contracts and atomic storage

**Type:** Story
**Status:** To Do
**Priority:** High

Canonical plan: [FX-BE-179](../../../../../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-179-durable-conversation-store/story.md).

## Impact and scope

Accepted messages, reply results, and execution progress survive failures as one consistent conversation.

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

## Validation and close conditions

Follow the canonical story and its task-specific tests; close only when all criteria have linked evidence. No external issue has been created.
