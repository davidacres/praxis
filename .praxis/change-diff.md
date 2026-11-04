# change-diff — PRX-S111-182 (FX-BE-182) recovery & QA repair

This recovery pass starts from `567a7300` on branch `praxis/wf-cb8e1255` (`main` base `59cba943`), hardens the recovery state transitions and coordinator guards for `TASK-482` and `TASK-483`, adds unit and repository decoder coverage for all four Review findings, and reverts out-of-scope E2E spec modifications so `selectAffectedTests` runs strictly the scoped assistant/team-chat suites.

## Review findings addressed

1. **Pre-dispatch (`prepared`) recovered result import (`teamChatTransitions.ts`, `teamChatCoordinator.ts`, `teamChatTransitions.test.ts`, `teamChatCoordinator.test.ts`, `teamChatRepository.test.ts`):**
   - `completeConversationAttempt` explicitly defines `ACTIVE_ATTEMPT_STATES`, `RECOVERABLE_TURN_STATES` (`'running'`, `'cancelling'`, `'interrupted'`, `'outcome_unknown'`, `'failed'`), and `RECOVERABLE_ATTEMPT_STATES` (`'prepared'`, `'dispatching'`, `'running'`, `'awaiting_approval'`, `'interrupted'`, `'outcome_unknown'`, `'failed'`).
   - When `recoveredResultId` matches a durable `final_result` evidence entry on the attempt with exact `(conversationId, turnId, participantId, attemptId, coordinatorEpoch)` identity, `completeConversationAttempt` and `importRecoveredResult` permit completion from `prepared` (or post-startup `interrupted` / `outcome_unknown`) without requiring `dispatchIntent`, while still enforcing the originating `attempt.coordinatorEpoch` and duplicate-import fences.
   - `TeamChatCoordinator.initialize()` checks all recoverable attempt states (`'prepared'`, `'dispatching'`, `'running'`, `'awaiting_approval'`, `'interrupted'`, `'outcome_unknown'`, `'failed'`) when importing durable `final_result` records across restarts.
   - Verified by `pre-dispatch recovery requires exact durable result and imports only once` (`teamChatTransitions.test.ts:87`), `startup imports a prepared attempt result without dispatching the provider` (`teamChatCoordinator.test.ts:613`), and `startup evidence and recovered reply survive repeated durable epoch changes` (`teamChatRepository.test.ts:115`).

2. **Settled-after-abort result import (`teamChatCoordinator.ts`, `teamChatCoordinator.test.ts`):**
   - When an active turn is cancelled (`state: 'cancelling'`) and the underlying execution promise subsequently settles with a `result`, `executeAttempt` records both the `reconciliation` (`execution-settled-after-abort`) and `final_result` (`execution-adapter-after-abort`) evidence and invokes `importRecoveredResult(conversationId, activeTurn.id, attemptId)` to atomically import the reply and complete the attempt instead of stranding the turn in `outcome_unknown`. If settlement produces no result, the attempt transitions to `outcome_unknown` (when tool-capable or lacking non-tool evidence) or `cancelled`.
   - Verified by `active cancellation remains cancelling until execution settles and records evidence` (`teamChatCoordinator.test.ts:570`).

3. **Originating vs. observing epoch schema and repository decoder validation (`assistantTypes.ts`, `teamChatTransitions.ts`, `teamChatCoordinator.ts`, `teamChatRepository.ts`, `teamChatRepository.test.ts`):**
   - `ConversationRecoveryEvidence` keeps `coordinatorEpoch` bound to the attempt's immutable originating epoch and models later observation provenance via optional `observingEpoch?: string` (populated on startup reconciliation in `beginConversationEpoch` and on user decision records in `resolveAttempt`).
   - `FileTeamChatRepository` (`teamChatRepository.ts:53-55`) validates `evidence.coordinatorEpoch === attempt.coordinatorEpoch` and rejects empty or non-string `observingEpoch` values on read and write.
   - Verified by `repeated startup retains originating attempt epoch and observation provenance` (`teamChatTransitions.test.ts:58`), `startup evidence and recovered reply survive repeated durable epoch changes` (`teamChatRepository.test.ts:115`), and `repository validates observation epochs separately from immutable attempt epochs` (`teamChatRepository.test.ts:155`).

4. **Direct `retryParticipant` rejection on `outcome_unknown` (`teamChatCoordinator.ts`, `teamChatCoordinator.test.ts`):**
   - `TeamChatCoordinator.retryParticipant` checks both `targetTurn?.state === 'outcome_unknown'` and `lastAttempt?.state === 'outcome_unknown'` and rejects with `'Unknown outcome: use resolveAttempt with reconciliation evidence and duplicate-risk acknowledgement.'` before any state mutation or provider dispatch.
   - Verified by `direct unknown-outcome retry requires informed resolution without dispatch` (`teamChatCoordinator.test.ts:606`).

## QA findings addressed

- **Root cause of unrelated E2E failures in QA (`scheduledRuns.spec.ts:348`, `sessionShelf.spec.ts`):** Earlier commits on this branch had modified 6 out-of-scope E2E spec files (`marketplace.spec.ts`, `scheduledRunEndToEnd.spec.ts`, `scheduledRuns.spec.ts`, `sessionShelf.spec.ts`, `sessionShelfNotes.spec.ts`, `sidebarNotes.spec.ts`), causing `selectAffectedTests` (`git diff --name-only main..HEAD`) to include those pointer/hover/timing-sensitive specs in the parallel unattended QA run.
- **Fix:** Reverted all 6 out-of-scope E2E spec files and regenerated `docs/praxis-tests/catalog.json` and `docs/praxis-tests/index.md` so they have zero diff against `main`. Verified that both `e2e/scheduledRuns.spec.ts:348` and `e2e/sessionShelf.spec.ts` pass (`6 passed`) against the unmodified baseline, and verified that all 32 scoped assistant/session/permission E2E tests (`e2e/assistant.spec.ts`, `e2e/quickSession.spec.ts`, `e2e/aiPermissions.spec.ts`) pass (`32 passed`).

## Verification

- `npm run build:core` — passed.
- `npm run test:core` — **1,913 passed, 2 skipped, 0 failed**.
- `npm run check-types` — passed across all workspaces.
- `npm run build:renderer && npm run desktop:copy-renderer && npm run build:desktop` — passed.
- `npm run test:desktop:git` — **119 passed, 0 failed**.
- Targeted FX-BE-182 Node suites (`teamChatRecovery.test.js`, `teamChatTransitions.test.js`, `teamChatCoordinator.test.js`, `teamChatExecutionAdapter.test.js`, `teamChatRepository.test.js`) — **44 passed, 0 failed**.
- Scoped functional Playwright E2E (`e2e/assistant.spec.ts`, `e2e/quickSession.spec.ts`, `e2e/aiPermissions.spec.ts`) — **32 passed, 0 failed**.
- Previously reported QA specs (`e2e/scheduledRuns.spec.ts:348`, `e2e/sessionShelf.spec.ts`) — **6 passed, 0 failed**.
- `npm run test:praxis-contracts` — **784 Playwright tests catalogued and linked**, 0 warnings.

## Patch artifact

- [`.praxis-change-diff.patch`](../.praxis-change-diff.patch) and [`.praxis/session-artifacts/change-diff.patch`](session-artifacts/change-diff.patch) contain the full source, test, and contract diff against `main`.
