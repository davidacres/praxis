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

## Scheduled delivery and verification ownership

Follow the parent feature's scheduled execution contract. The process runs this task's checks and performs visual inspection immediately when visible behavior changes, retaining useful screenshots. Human review is deferred until all twelve tasks are delivered. Record the prerequisite/result commits and evidence in the task handoff; do not execute against a base missing predecessor changes or bypass an approval gate to advance the queue.

## Evidence

- `cd packages/core && npx tsc -p . && node --test out/ai/assistant/teamChat*.test.js out/ai/assistant/assistantEngine.test.js out/ai/aiSessionManager.test.js` — 136 passed, 0 failed. New suite `teamChatCancelRetryApproval.test.ts` (registered in the core `test` list) covers cancel/skip/queued/other-conversation isolation, partial-output evidence, retry with exactly-once successors, approval record/fence/restore/invalidate and user-authorized unknown-outcome retry (`retryKind: 'user-authorized-unknown'`).
- `cd apps/praxis-desktop/main && npm run compile && node --test out/main/teamChatExecutionAdapter.test.js out/main/teamChatIpcRecovery.test.js out/main/teamChatCommands.test.js out/main/teamChatActivation.test.js out/main/adapters/teamChatRepository.test.js` — 55 passed, 0 failed.
- Approval identity is derived from the runtime session (`<sessionId>:permission:<n>`) because the runtime queues carry no request id; after a process restart no session is live, so approvals are invalidated and the attempt stays interrupted/outcome_unknown.
- Not run: full desktop functional/theme e2e, real-provider checks, manual passes (no UI change).
