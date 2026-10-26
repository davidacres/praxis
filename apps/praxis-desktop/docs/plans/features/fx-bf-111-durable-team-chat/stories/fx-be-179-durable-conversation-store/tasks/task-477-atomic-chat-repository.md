---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-477
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-179
---

# TASK-477: Implement serialized durable conversation transactions

Parent: [FX-BE-179](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Evolve TeamChatStore behind a transaction repository contract; add a chat-specific desktop file adapter with clone-before-commit state and explicit corruption errors. Keep the existing profile-local team-chats.json storage location and avoid changing unrelated JsonKeyValueStore callers.

## Dependencies

TASK-476

## Acceptance criteria

- Concurrent mutations across two chats and two windows retain every accepted change; one profile-wide writer serializes the shared snapshot.
- Failure before rename leaves the old committed snapshot readable and emits no accepted acknowledgement; ambiguous failures after rename stop dispatch and require reload/reconciliation.
- Submit commits user message, immutable response plan and command receipt together; completion commits final reply, attempt outcome and context boundary together.
- Malformed existing JSON is surfaced as a recoverable storage error and is never replaced with an empty chat list.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments
