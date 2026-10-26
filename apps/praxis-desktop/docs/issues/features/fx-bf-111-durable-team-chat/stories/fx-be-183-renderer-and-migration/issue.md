# FX-BE-183: Renderer subscription, single navigation entry, and legacy migration

**Type:** Story
**Status:** To Do
**Priority:** High

Canonical plan: [FX-BE-183](../../../../../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-183-renderer-and-migration/story.md).

## Impact and scope

Existing chats remain accessible and the UI reflects one durable conversation across all shells.

## Dependencies

FX-BE-182

## Acceptance criteria

- 484: Two windows show the same committed transcript, active member and queue after reload; dock/float switching does not change execution ownership.
- 484: Classic and Easy Mode show one team-chat row and exclude typed internal executions on initial load and incremental updates; standalone chats stay visible.
- 484: Context detach remains one submitted message, mentions still work, actions retain Preview Changes and apply only on the compatible current page.
- 484: Queued submissions retain their captured context and attachments; navigation cannot redirect a pending reply into another chat.
- 484: Keyboard and accessible names cover stop, retry, queued cancellation, pinned decisions and outcome resolution; errors remain visible until resolved.
- 485: A copied legacy fixture preserves chat/message IDs, titles, order, timestamps, roles, actions, choices, errors and project ownership; migration rerun changes nothing.
- 485: Provable session associations import typed links only after validation; ambiguous instruction-title matches never merge conversations or delete records.
- 485: Migration failure leaves the original store and backup intact, with durable dispatch disabled; activation blocks legacy transcript writes.
- 485: An active legacy execution causes cutover to wait for quiescence; no chat is written by old and new coordinators at once.
- 485: A fixture with an expired legacy session continues using reconstructed context and still appears exactly once in navigation.

## Validation and close conditions

Follow the canonical story and its task-specific tests; close only when all criteria have linked evidence. No external issue has been created.
