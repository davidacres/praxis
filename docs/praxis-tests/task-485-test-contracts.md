# test-contracts — PRX-T111-485 / TASK-485

Stage: **WF-F42781CA-test-contracts**. Frozen implementation: `c750c105b93b45a304fbdcbaf5f8c1a2c10829c5` (one commit, "import provable legacy runtime links at cutover"). At entry the worktree HEAD matched it and was clean. This stage changes catalog documentation only.

## Result

- **Playwright catalog:** `npm run test:praxis-contracts` exit 0 before and after editing: **804 Playwright tests catalogued and linked**, no warnings. The implement stage had already regenerated `catalog.json` / `index.md` for the one new spec test, PT-D54AE14ABC, but left its flow as generator placeholder text. This stage wrote its Given/When/Then and updated PT-EA127A3852, whose prose said association import "is not exercised"; it now asserts `legacyRuntimeLinks` is absent and points to PT-D54AE14ABC.
- **TASK-485 Node contracts:** **9** new contracts in [FX-BE-183](fx-be-183-renderer-migration.md), one per new `test(...)`: `teamChatMigration` 4, `teamChatActivation` 1, `teamChatRepository` 1, `teamChatIpcRecovery` 3. FX-BE-183 now holds **82**.
- **Renamed test:** c750c105 renamed `teamChatMigration.test.ts:60`. Its id is derived from the title, so PT-A89FD06E4B is **retired** and replaced in place by **PT-CE0D0A3FCE** in [FX-BE-184 release proof](fx-be-184-release-proof.md). It is listed only there, so it is counted once.
- **Links re-pointed:** in FX-BE-183, all 8 activation links moved +1 (c750c105 added an import). In the release proof, 5 links: `teamChatActivation.test.ts` 76→77 and `durableTeamChat.spec.ts` 536→610 (both moved by c750c105), and three older drifts found by the audit: `teamChatExecutionAdapter.test.ts` 65→66 and 90→91, `teamChatCoordinator.test.ts` 800→844.
- **Source audit** (scratch script outside the repo; id = SHA1(file + newline + title), exact title at the linked line) over every `### PT-` contract under `docs/praxis-tests`: **111 pass, 0 stale**. The 2 repeated ids (PT-4485239A20, PT-A75870DFCA) are the release proof's documented "strengthened contract" re-listings. PT-EE0AB4E23D in the release proof is a Playwright cross-reference to the catalog's own entry, not a collision. No new id collides with any other.
- **Focused runs (executed at c750c105):**
  - `cd packages/core && npx tsc -p . && node --test out/ai/assistant/teamChatMigration.test.js` — **9 passed, 0 failed**.
  - `cd apps/praxis-desktop/main && npm run compile && node --test out/main/teamChatActivation.test.js out/main/teamChatIpcRecovery.test.js out/main/adapters/teamChatRepository.test.js` — **40 passed, 0 failed** (includes parameterised cases).
  - All four suites are already in the explicit npm lists (core `test`, main `test:git`).
- **Not rerun:** `durableTeamChat.spec.ts` (PT-D54AE14ABC, PT-EA127A3852). It needs the downstream build and `copy-renderer` steps. Its screenshot `.praxis/session-artifacts/task-485-migrated-chat.png` comes from the implement stage's run. This stage did no visual check: it writes no UI code.
- **Not run (scheduled-run policy):** full functional and theme e2e suites, live API proofs, manual theme passes.

## Coverage by acceptance criterion

| Criterion | Node contracts | Playwright |
| --- | --- | --- |
| AC1 Copied legacy fixture keeps chat/message ids, titles, order, timestamps, roles, actions, choices, errors and project ownership; rerun changes nothing | PT-09749D9091 (field-for-field, byte-identical rerun); also PT-0FF1EBFFE5, PT-0651E34994 | PT-EA127A3852 (`durableTeamChat.spec.ts:145`) |
| AC2 Provable associations import typed links only after validation; ambiguous/title matches never merge or delete | PT-CC1D097FDA, PT-683F7F8A2E, PT-BB39A41A4B, PT-ECC22CD4F9, PT-C5226F41B4 (validated on load), PT-CE0D0A3FCE, PT-89F193A693 (title-only) | PT-D54AE14ABC (`:177`, stray title-matched key → diagnostic, one conversation, both session records kept) |
| AC3 Migration failure leaves source and backup intact with durable dispatch disabled; activation blocks legacy writes | PT-3DD9007925, PT-97215CDBB8; also PT-5FFDF30323, PT-63819EA534, and `teamChatIpcRecovery.test.ts:86` "activation failure leaves durable dispatch disabled" (FX-BE-184 era) | — |
| AC4 An active legacy execution makes cutover wait; no chat written by both coordinators | PT-E8B588C412; also PT-1FC2813D4B | — |
| AC5 Expired legacy session continues with reconstructed context and appears once in navigation | — | PT-D54AE14ABC (link imported, history reaches the provider, no binding reuse, one row across two reloads) |

## Findings

1. **"Instruction or title match" is a key-shape rule at the unit level.** `LegacyRuntimeSessionEvidence` has no goal or title field, so PT-683F7F8A2E proves only that a key not naming a chat id is a diagnostic. The equal-title case is proven end to end by PT-D54AE14ABC (goal text equals the saved title), which this stage did not rerun.
2. **PT-97215CDBB8's title names `saveChat`, but the test does not call the IPC handler.** It reproduces the handler's call (`activation.legacy(() => store().saveMessages(...))`, as in `assistantIpc.ts:337`). A change to the handler's wrapping would not fail this test.
3. **AC4's "no chat is written by old and new coordinators at once" is shown by ordering, not by a concurrent write race.** PT-E8B588C412 proves the durable coordinator does not exist and the file is unchanged while legacy work is held, and that legacy writes land before the backup. No test runs a legacy write that starts after cutover begins and lands in the durable store (new legacy work is rejected instead).
4. **AC5 runs only in Playwright.** No Node test drives reconstruction for a linked conversation. PT-D54AE14ABC also writes a screenshot it never compares.
5. **Existing count mismatch, not caused by TASK-485:** the release-proof header says 27 source contracts; the file has 29 entries (the 2 strengthened re-listings plus the PT-EE0AB4E23D Playwright cross-reference fit the description loosely). This stage kept the count unchanged and did not rewrite that header.
6. **Historical report now out of date:** [fx-be-184-verification-report.md](fx-be-184-verification-report.md) (AC7, gap G5) says a provable legacy association "cannot be tested". TASK-485 now tests it (PT-CC1D097FDA, PT-D54AE14ABC). That report is a dated record and was left unchanged.
7. **Older line drift in `test-contracts.md`:** it links PT-EA127A3852 to `durableTeamChat.spec.ts#L142`; the test is at 145. Not caused by TASK-485, left as is.
