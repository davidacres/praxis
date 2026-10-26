---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-484
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-183
---

# TASK-484: Make the assistant UI a conversation command client

Parent: [FX-BE-183](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Refactor AssistantProvider into a snapshot/subscription client retaining local drafts and page registration. Update AssistantPanel, dock/floating shells and both sidebar consumers using typed ownership. Add queue, interruption, context-required and recovery controls with existing themed primitives.

## Dependencies

TASK-483

## Acceptance criteria

- Two windows show the same committed transcript, active member and queue after reload; dock/float switching does not change execution ownership.
- Classic and Easy Mode show one team-chat row and exclude typed internal executions on initial load and incremental updates; standalone chats stay visible.
- Context detach remains one submitted message, mentions still work, actions retain Preview Changes and apply only on the compatible current page.
- Queued submissions retain their captured context and attachments; navigation cannot redirect a pending reply into another chat.
- Keyboard and accessible names cover stop, retry, queued cancellation, pinned decisions and outcome resolution; errors remain visible until resolved.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments
