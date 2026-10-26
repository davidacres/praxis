---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-483
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-182
---

# TASK-483: Implement safe cancellation, retry, and approval restoration

Parent: [FX-BE-182](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Wire coordinator operations to existing runtime abort and permission APIs. Record user recovery decisions; retain partial output as attempt evidence. Reconnect approvals by stable runtime request identity or mark them interrupted.

## Dependencies

TASK-482

## Acceptance criteria

- Cancel retains completed member replies, marks remaining members skipped and cancels queued turns in that conversation; a running tool remains cancelling until termination or outcome_unknown is established.
- Retry targets only the failed/interrupted member, appends a new attempt and preserves completed predecessors; successors resume once the retry commits.
- Restart invalidates unresolved approval callbacks; approval is requested again only after verifying a live matching runtime request, never transferred to a new attempt.
- A user-authorized retry after outcome_unknown records duplicate-action risk acknowledgement and the reconciliation evidence; it cannot be mistaken for a safe automatic retry.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments
