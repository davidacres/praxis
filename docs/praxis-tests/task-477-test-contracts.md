# test-contracts — PRX-T111-477 / TASK-477

Stage: **WF-D33586FC-test-contracts**. Frozen implementation: `d15874efacfb1159c74e1ddee1fa97e0235de4be`. At entry the worktree HEAD matched it and was clean. This stage changes catalog documentation only.

## Result

- **Playwright catalog:** `npm run test:praxis-contracts` exit 0. **802 Playwright tests catalogued and linked**, with no warnings. Before regeneration it failed with one problem: the new test `durableTeamChat.spec.ts:431` was missing. `-- --write` added **PT-68979E242A** (801 → 802) and refreshed three moved line hints (430/466/494 → 472/508/536). The placeholder flow was then replaced with curated Given/When/Then.
- **TASK-477 Node contracts:** 4 new contracts (`teamChatIpcRecovery.test.ts`) and 1 strengthened (PT-A2B09A999F). 12 contracts in other files were re-linked after this commit moved their lines.
- **Source audit** (SHA1(file + newline + title) id, exact title at the linked line) over `fx-be-179`, `fx-be-181`, `fx-be-182` and `fx-be-184-release-proof`: **56 pass**, 2 parameterised links resolve, and **22 fail**. All 22 fail only on the line hint, and all 22 are the stale core links already reported by TASK-476 (finding 6). None is in a file TASK-477 changed.
- **Focused runs (executed):**
  - `npm run build:core`, then `npm run compile` in `apps/praxis-desktop/main`, then `node --test out/main/adapters/teamChatRepository.test.js out/main/teamChatIpcRecovery.test.js`: **24 passed, 0 failed, 0 skipped**. Both files are in `test:git`'s explicit list.
  - `npm run build:renderer && npm run desktop:copy-renderer && npm run build:desktop`, then `npx playwright test e2e/durableTeamChat.spec.ts -g "malformed team-chat file"`: **2 passed** (the smoke and functional projects).
- **Visual check:** `.praxis/session-artifacts/task-477-corrupt-storage.png` (written by the test, gitignored) shows the sidebar alert with Retry, zero chat rows, the draft kept, and the refused send.
- **Not run (scheduled-run policy):** the full functional and theme e2e suites, live API proofs, and manual theme passes.

## Coverage links

| ID | Automation | Contract | Change |
| --- | --- | --- | --- |
| PT-68979E242A | Playwright [durableTeamChat.spec.ts:431](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L431) | [catalog](index.md) | new, curated flow |
| PT-A2B09A999F | node [teamChatRepository.test.ts:65](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L65) | [FX-BE-179](fx-be-179-conversations.md#pt-a2b09a999f) | strengthened: pre-rename submit, plan/receipt revision, one-revision completion, binding coverage |
| PT-3B6907BAE3 | node [teamChatIpcRecovery.test.ts:119](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L119) | [FX-BE-179](fx-be-179-conversations.md#pt-3b6907bae3) | new |
| PT-EC587520ED | node [teamChatIpcRecovery.test.ts:140](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L140) | FX-BE-179 | new (skipped on Windows) |
| PT-E8F72FF1BC | node [teamChatIpcRecovery.test.ts:169](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L169) | FX-BE-179 | new (skipped on Windows) |
| PT-EA0DBBC504 | node [teamChatIpcRecovery.test.ts:207](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L207) | FX-BE-179 | new |
| PT-ABE894C263 | node teamChatRepository.test.ts:124 | [FX-BE-181](fx-be-181-provider-context.md#pt-abe894c263) | link 93→124 |
| PT-0ECEA64537, PT-853EBCDC9F | node teamChatRepository.test.ts:146, :186 | [FX-BE-182](fx-be-182-interruption-recovery.md) | links 115→146, 155→186 |
| PT-020116C43E (+6 case rows), PT-DF4DDACEB9, PT-315DCCA855, PT-ED8AC5EE8A | node teamChatRepository.test.ts:224, :250, :273, :290 | [FX-BE-184 release proof](fx-be-184-release-proof.md) | links +31 |
| PT-159068A7D0, PT-57FD906F86, PT-7231E7679E | node teamChatIpcRecovery.test.ts:38, :72, :86 | FX-BE-184 release proof | links +3 |
| PT-EE0AB4E23D | Playwright durableTeamChat.spec.ts:536 | FX-BE-184 release proof | link 494→536 |

`fx-be-184-retained-evidence.md` quotes old line numbers inside a verbatim captured log. That is historical evidence, so it was left as captured.

### Acceptance criteria → contracts

| Criterion | Contracts |
| --- | --- |
| Concurrent mutations across two chats and two windows retain every accepted change; one profile-wide writer serializes the snapshot | PT-EA0DBBC504 (services + second window, distinct revisions), PT-5D662AA252 (two repositories), PT-315DCCA855 (second instance refused or serialized) |
| Failure before rename leaves the old snapshot readable and emits no acknowledgement | PT-3B6907BAE3 (no `turn_accepted`, no dispatch, same command then succeeds once), PT-F820CEA7FB, PT-A2B09A999F (submit and completion), PT-020116C43E (ENOSPC/EACCES) |
| Ambiguous failure after rename stops dispatch and requires reload/reconciliation | PT-EC587520ED (submit: not acknowledged, writes fenced, replay returns the original turn), PT-E8F72FF1BC (reservation: halt + "Restart Praxis…", no provider call, interrupted after restart), PT-C7DEB31799 |
| Submit commits user message, immutable plan and receipt together | PT-A2B09A999F, PT-8E485B3B5F (core transition) |
| Completion commits final reply, attempt outcome and context boundary together | PT-A2B09A999F (one revision, binding delivered/native output), PT-23E865D1FD (core transition) |
| Malformed JSON is a recoverable storage error and never replaced with an empty list | PT-68979E242A (UI alert, refused send, bytes and siblings unchanged, Retry recovers), PT-C4174FDDA7, PT-DF4DDACEB9 |

## Findings

1. **A pre-rename fault during attempt reservation has no test.** The coordinator change rethrows every non-`ReservationRejected` error to the halting handler. Only the post-rename (uncertain) reservation fault is exercised (PT-E8F72FF1BC). Two branches are not asserted: the quiet `break` for a refused reservation, and a pre-rename reservation fault reaching the halt report. A core `teamChatCoordinator.test.ts` case would close this.
2. **"Keeps the last list" on a failed refresh has no test.** `useProjectsTeamChatsState` is meant to keep the previous list when a read fails. The e2e reloads the window before the failure, so no prior list exists, and it asserts zero rows. There is no renderer unit test for the hook.
3. **The send refusal shows raw IPC text (ambiguous UX).** The alert reads "Error invoking remote method 'assistant:createChat': TeamChatStorageError: … /private/var/folders/…/team-chats.json: SyntaxError …", including an absolute path. The test asserts only the substring "Cannot read team chat storage", so the wording is not under contract. The refusal also comes from chat creation, not from a turn submit. The flow says so.
4. **Error `name` values are not asserted directly.** `TeamChatStorageError` and `TeamChatCommitUncertainError` now set `name`. Tests match by class (`assert.rejects(..., Class)`) or by message. The name shows in the sidebar alert detail, but no assertion pins it.
5. **Platform skips.** PT-EC587520ED and PT-E8F72FF1BC skip on Windows (no directory flush), so the ambiguous-after-rename criterion has no Windows evidence.
6. **Stale core line hints carried over from TASK-476 (not fixed, out of scope).** There are 22 links in FX-BE-181 and FX-BE-182: `teamChatBindings.test.ts`, `teamChatContext.test.ts`, `teamChatCoordinator.test.ts` and the `teamChatRecovery.test.ts` matrix. Their titles and ids are intact. TASK-477 did not touch these files.
7. **Node contracts are outside the generator.** `praxis-test-catalog.cjs` indexes Playwright only. For the Node contracts, the audit above and the executed `node --test` run are the evidence, not the validator.
