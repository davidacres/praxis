---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Story
**Priority:** High
id: FX-BE-183
type: Story
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
issue: docs/issues/features/fx-bf-111-durable-team-chat/stories/fx-be-183-renderer-and-migration/issue.md
---

# FX-BE-183: Renderer subscription, single navigation entry, and legacy migration

Parent: [FX-BF-111](../../feature.md). Issue mirror: [FX-BE-183](../../../../../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-183-renderer-and-migration/issue.md).

## User or operational impact

Existing chats remain accessible and the UI reflects one durable conversation across all shells.

## Scope

- Refactor AssistantProvider into a snapshot/subscription client retaining local drafts and page registration. Update AssistantPanel, dock/floating shells and both sidebar consumers using typed ownership. Add queue, interruption, context-required and recovery controls with existing themed primitives.
- Implement the migration and activation protocol in the feature design. Preserve legacy transcripts and session records, convert only provable associations and retain narrow legacy navigation classification. Update renderer area notes and desktop feature parity documentation.

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

## Tasks

- [TASK-484: Make the assistant UI a conversation command client](tasks/task-484-conversation-ui.md)
- [TASK-485: Migrate existing chats and stage the durable-writer cutover](tasks/task-485-legacy-migration.md)

## Validation

Use the parent feature acceptance-to-suite mapping and validation commands. Each task supplies executable scenarios; record exact commands, assertion names and artifacts. This story does not close on typechecking alone.

## Close when

Both tasks satisfy every acceptance criterion, results are linked here and in the issue mirror, and no story-specific recovery or compatibility gap remains.

## Description


## Comments
