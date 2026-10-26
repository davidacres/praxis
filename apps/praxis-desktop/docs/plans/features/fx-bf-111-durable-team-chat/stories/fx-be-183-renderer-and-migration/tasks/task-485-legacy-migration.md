---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-485
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-183
---

# TASK-485: Migrate existing chats and stage the durable-writer cutover

Parent: [FX-BE-183](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Implement the migration and activation protocol in the feature design. Preserve legacy transcripts and session records, convert only provable associations and retain narrow legacy navigation classification. Update renderer area notes and desktop feature parity documentation.

## Dependencies

TASK-484

## Acceptance criteria

- A copied legacy fixture preserves chat/message IDs, titles, order, timestamps, roles, actions, choices, errors and project ownership; migration rerun changes nothing.
- Provable session associations import typed links only after validation; ambiguous instruction-title matches never merge conversations or delete records.
- Migration failure leaves the original store and backup intact, with durable dispatch disabled; activation blocks legacy transcript writes.
- An active legacy execution causes cutover to wait for quiescence; no chat is written by old and new coordinators at once.
- A fixture with an expired legacy session continues using reconstructed context and still appears exactly once in navigation.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments
