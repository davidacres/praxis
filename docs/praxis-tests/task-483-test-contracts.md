# test-contracts — PRX-T111-483 / TASK-483

Stage: **WF-03EC4693-test-contracts**. Frozen implementation: `cdc6ec507f7f2fee56bfa689e0f841b1e0b93ff1`. At entry the worktree HEAD matched it and was clean. This stage changes catalog documentation only.

## Result

- **Playwright catalog:** `npm run test:praxis-contracts` exit 0 before and after editing: **803 Playwright tests catalogued and linked**, no warnings. TASK-483 changed no Playwright spec, so `catalog.json` and `index.md` need no change.
- **TASK-483 Node contracts:** 15 new contracts in [FX-BE-182](fx-be-182-interruption-recovery.md#task-483-cancellation-retry-and-approval-restoration), which now holds **34**. No existing id changed.
- **Links re-pointed in FX-BE-182:** 13 line hints had drifted (6 matrix cases 7→6; coordinator 655→699, 668→712, 686→730, 708→752 ×2, 722→766, 729→773; adapter 31→32, the last caused by TASK-483's own import line).
- **Source audit** of FX-BE-182 (id = SHA1(file + newline + title), title at the linked line): **28 pass**; the 6 matrix cases build their title by concatenation and were checked by hand at line 6.
- **Focused runs (executed):**
  - `npm run build:core && cd packages/core && node --test out/ai/assistant/teamChatCancelRetryApproval.test.js out/ai/assistant/teamChatTransitions.test.js out/ai/assistant/teamChatCoordinator.test.js out/ai/assistant/teamChatRecovery.test.js out/ai/assistant/teamChatCrashBoundaries.test.js`: **72 passed, 0 failed, 0 skipped**, including all 12 in `teamChatCancelRetryApproval.test.ts`.
  - `cd apps/praxis-desktop/main && npm run compile && node --test out/main/teamChatExecutionAdapter.test.js out/main/teamChatIpcRecovery.test.js`: **24 passed, 0 failed, 0 skipped**.
  - All four files are in the explicit npm lists: core `test` and main `test:git`.
- **Visual check:** not performed. TASK-483's commit changes no renderer code, so there is no screenshot to keep.
- **Not run (scheduled-run policy):** full functional and theme e2e suites, live API proofs, manual theme passes. The related Playwright specs below were not rerun: TASK-483 did not change them.

## Coverage links

| Criterion | Node contracts | Related Playwright (catalog) |
| --- | --- | --- |
| AC1 Cancel keeps completed replies, skips the rest, cancels queued turns; a running tool stays cancelling until it settles or becomes outcome_unknown | PT-82B6E77B60, PT-CC185BD61C, PT-4DA103C9B3 | PT-829EB33638 (`durableTeamChat.spec.ts:176`) |
| AC2 Retry targets only the failed member, appends an attempt, keeps predecessors, successors resume after commit | PT-591E3339A9 | — |
| AC3 Restart invalidates unresolved approvals; restored only for a live matching runtime request, never moved to a new attempt | PT-F4740014B7, PT-A64184151D, PT-111CBBC363, PT-075F11B417, PT-E16F79FB31, PT-2A03F67EEF, PT-077F329D57, PT-CF23068423, PT-AF00EAF3FB, PT-B424123131 | PT-0DD1738998 (`durableTeamChat.spec.ts:475`), PT-6A15DADEFB (`:598`) |
| AC4 A user-authorized retry after outcome_unknown records the risk acknowledgement and reconciliation evidence, distinct from a safe retry | PT-9E656E5B4B | PT-C44D501ACA (`durableTeamChat.spec.ts:104`) |

## Findings

1. **Production approval ordering is not directly tested.** The fix commit makes the production adapter run `onApproval` calls in order (`approvalQueue` in `teamChatExecutionAdapter.ts`) and makes `completeWithTools` (`assistantIpc.ts`) resolve the previous request before recording a new one. No test drives either path. PT-AF00EAF3FB proves the coordinator handles that order when a fake adapter awaits each call; it does not prove the production code produces it.
2. **AC2 has no Playwright journey.** Retrying a failed (not unknown-outcome) member is covered only in core. PT-C44D501ACA covers the unknown-outcome retry.
3. **AC1's "running tool" is an adapter that never reports an outcome.** PT-CC185BD61C does not run a real tool or a real ACP abort; termination evidence from a live runtime is not exercised.
4. **PT-0DD1738998 does not assert the persisted approval record.** It checks the attempt goes `outcome_unknown`, is not reused and no session still awaits approval, but not `pendingApproval.status` on disk. The restore/invalidate result is proved only by node tests (PT-075F11B417 against a real file). Not stale: no Playwright spec relies on the changed request-id format.
5. **Stale contracts in FX-BE-180 (not changed here):** PT-1A2365951E ("TASK-479 AC2: Subscription emits revision updates"), PT-F4C7E562E3 ("TASK-479 AC3: Invalid participant… rejected before provider invocation") and PT-91F0C03FD3 ("TASK-479 AC4: cancellation preserves unresolved execution as unknown") name titles that no longer exist in `teamChatCoordinator.test.ts`. Checkpoint 85cbfb79 (TASK-479) renamed or merged them, e.g. into `subscription emits turn_accepted, attempt and completion revision updates` (line 426) and the longer AC3 title at line 453. They need new ids from a TASK-479/FX-BE-180 contracts pass. TASK-483 did not cause this.
6. **Line drift in FX-BE-181 (not changed here):** `fx-be-181-provider-context.md` has 13 line hints off by 1–44 lines. Ids and titles still match. TASK-483 did not cause this. FX-BE-179: 19/19 pass.
