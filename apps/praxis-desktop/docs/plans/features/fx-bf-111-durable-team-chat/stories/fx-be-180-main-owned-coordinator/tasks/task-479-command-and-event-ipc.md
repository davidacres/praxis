---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-479
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-180
---

# TASK-479: Expose validated commands and revisioned conversation updates

Parent: [FX-BE-180](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Replace renderer-owned turn/save sequencing with submitTurn, getConversation, listChats, subscribe, cancelTurn, retryParticipant and resolveAttempt commands through AssistantIpc/preload. Keep CRUD routed through the same repository; reject legacy whole-transcript saves for migrated chats.

## Dependencies

TASK-478

## Acceptance criteria

- An IPC timeout after durable acceptance followed by resubmission of the same command ID returns the original turn ID.
- A new window loads a snapshot and applies newer revisions; duplicate events are ignored and a revision gap triggers a fresh snapshot without replaying work.
- Invalid participant, project, attachment reference, permission choice and stale retry target are rejected before provider invocation.
- Closing the initiating renderer does not cancel accepted work; another window can observe the same turn and pending approval.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments
