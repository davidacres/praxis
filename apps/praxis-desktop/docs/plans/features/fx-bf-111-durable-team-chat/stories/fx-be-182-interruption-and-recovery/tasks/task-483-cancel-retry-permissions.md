---
**Status:** ✅ Complete
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


**PRX-T111-483** — 2026-11-05T18:59:37.785Z
**Workflow run failed: Governed delivery — TASK-483: Implement safe cancellation, retry, and approval restoration**

Status: Failed · Duration: 4m 50s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-T111-483** — 2026-11-05T21:05:09.311Z
**Workflow run failed: Governed delivery — TASK-483: Implement safe cancellation, retry, and approval restoration**

Status: Failed · Duration: 25m 4s

- ❌ Plan: failed
- ⏳ Implement: pending
- ⏳ Praxis Test contracts: pending
- ⏳ Review: pending
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "plan" failed.

**PRX-T111-483** — 2026-11-05T21:56:11.356Z
**Workflow run succeeded: Governed delivery — TASK-483: Implement safe cancellation, retry, and approval restoration**

Status: Succeeded · Duration: 10m 4s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ✅ QA: succeeded
- ✅ Security scan: succeeded
## Scheduled delivery and verification ownership

Follow the parent feature's scheduled execution contract. The process runs this task's checks and performs visual inspection immediately when visible behavior changes, retaining useful screenshots. Human review is deferred until all twelve tasks are delivered. Record the prerequisite/result commits and evidence in the task handoff; do not execute against a base missing predecessor changes or bypass an approval gate to advance the queue.

## Evidence

- `cd packages/core && npx tsc -p . && node --test out/ai/assistant/teamChat*.test.js out/ai/assistant/assistantEngine.test.js out/ai/aiSessionManager.test.js` — 141 passed, 0 failed. Suite `teamChatCancelRetryApproval.test.ts` (registered in the core `test` list) covers cancel/skip/queued/other-conversation isolation, partial-output evidence, retry with exactly-once successors, approval record/fence/restore/invalidate and user-authorized unknown-outcome retry (`retryKind: 'user-authorized-unknown'`). Follow-up cases: "an approval raised after cancel is rejected and the attempt is not reopened", "completing while awaiting approval resolves the pending approval", "failing while awaiting approval invalidates the pending approval", "a superseding runtime request resolves the previous one before recording the next", and a "no attempt identity" live request that must not restore. `teamChatTransitions.test.ts` adds "settleAttemptApproval acts only on a pending approval and is idempotent".
- `cd apps/praxis-desktop/main && npm run compile && node --test out/main/teamChatExecutionAdapter.test.js out/main/teamChatIpcRecovery.test.js out/main/mobilePermissions.test.js out/main/teamChatCommands.test.js out/main/teamChatActivation.test.js out/main/adapters/teamChatRepository.test.js` — 60 passed, 0 failed. "live approvals are reported only for the owning attempt while its session still awaits approval" now drives real `permission_requested` / `permission_completed` sequences.
- `npm run check-types` (root) — clean.
- Approval identity is shared with the mobile permission surface (`pendingMobilePermissions`): `<sessionId>:permission:<event index>` of the head of the session's pending queue, so it moves to the next queued request when one is answered. When the head changes mid-reply the previous request is resolved before the next is recorded, in order. After a process restart no session is live, so approvals are invalidated and the attempt stays interrupted/outcome_unknown; a live request is restored only when it names the same attempt.
- Pending approvals are settled when the attempt ends (resolved on completion, invalidated on failure or abort settlement), and a cancelling turn opens no new approval.
- Files deleted by the failed-run WIP commit 6aa6235a were restored in a separate commit.
- Not run: full desktop functional/theme e2e, real-provider checks, manual passes (no UI change).
