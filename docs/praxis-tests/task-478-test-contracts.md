# test-contracts — PRX-T111-478 / TASK-478

Stage: **WF-EB5697C1-test-contracts**. Frozen implementation: `6e296acb64d40d4e279f26d99f0df33339498655`. At entry the worktree HEAD matched it and was clean. This stage changes catalog documentation only.

## Result

- **Playwright catalog:** `npm run test:praxis-contracts` exit 0, before and after editing. **802 Playwright tests catalogued and linked**, with no warnings. TASK-478 changed no Playwright spec, so the generated catalog (`catalog.json`, `index.md`) needed no change.
- **TASK-478 Node contracts:** 2 new contracts (PT-5F483231F9 core, PT-E64E01B995 main), 4 strengthened to match the rewritten tests (PT-E6F300480C, PT-77195EEA97, PT-D5716B75D8, PT-C77A052502), and 1 stale contract replaced (PT-C8CB367EC7 → PT-91F0C03FD3). FX-BE-180 now holds **10 contracts**.
- **Links re-pointed:** this commit moved every test in `teamChatCoordinator.test.ts`. All 23 links into that file across FX-BE-180 to FX-BE-184 now point at the exact title line.
- **Source audit** (SHA1(file + newline + title) id, exact title at the linked line) over `fx-be-179`, `fx-be-180`, `fx-be-181`, `fx-be-182`, `fx-be-183` (coordinator section) and `fx-be-184-release-proof`: **50 pass**. 2 parameterised links (`…coordinator replacements: "restart result"` / `""`, line 708) were checked by hand and resolve. **12 fail on the line hint only**, all in files TASK-478 did not change (finding 7). Every id matches its title.
- **Focused runs (executed):**
  - `npm run build:core && node --test packages/core/out/ai/assistant/teamChatCoordinator.test.js`: **24 passed, 0 failed, 0 skipped**, including all five `TASK-478` tests.
  - `cd apps/praxis-desktop/main && npm run compile && node --test out/main/teamChatIpcRecovery.test.js`: **8 passed, 0 failed, 0 skipped**, including the new file-repository regression.
  - Both files are in the explicit npm lists: core `test` and main `test:git`.
- **Visual check:** not performed. TASK-478 changes no renderer code or UI, so there is no screenshot to keep.
- **Not run (scheduled-run policy):** the full functional and theme e2e suites, live API proofs, and manual theme passes.

## Coverage links

| ID | Automation | Contract | Change |
| --- | --- | --- | --- |
| PT-E6F300480C | node [teamChatCoordinator.test.ts:98](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L98) | [FX-BE-180](fx-be-180-coordinator.md#pt-e6f300480c) | strengthened: deferred repository, concurrent duplicate, sequences, single announcement, FIFO dispatch; link 65→98 |
| PT-77195EEA97 | node [teamChatCoordinator.test.ts:150](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L150) | [FX-BE-180](fx-be-180-coordinator.md#pt-77195eea97) | strengthened: all five roles, plan committed before dispatch, plan contents; link 124→150 |
| PT-D5716B75D8 | node [teamChatCoordinator.test.ts:218](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L218) | [FX-BE-180](fx-be-180-coordinator.md#pt-d5716b75d8) | strengthened: turn 2 accepted while turn 1 is in flight; link 188→218 |
| PT-C77A052502 | node [teamChatCoordinator.test.ts:282](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L282) | [FX-BE-180](fx-be-180-coordinator.md#pt-c77a052502) | rewritten: roster and runtime default changes after acceptance (failure half moved to PT-5F483231F9); link 241→282 |
| PT-5F483231F9 | node [teamChatCoordinator.test.ts:347](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L347) | [FX-BE-180](fx-be-180-coordinator.md#pt-5f483231f9) | new |
| PT-E64E01B995 | node [teamChatIpcRecovery.test.ts:235](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L235) | [FX-BE-180](fx-be-180-coordinator.md#pt-e64e01b995) | new (main, file repository) |
| PT-126F6268D2, PT-1A2365951E, PT-F4C7E562E3 | node teamChatCoordinator.test.ts:395, :420, :447 | FX-BE-180 | links +95 |
| PT-91F0C03FD3 | node [teamChatCoordinator.test.ts:500](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L500) | [FX-BE-180](fx-be-180-coordinator.md#pt-91f0c03fd3) | replaces PT-C8CB367EC7 (title was renamed earlier; old id matched no source) |
| PT-36D88646CB, PT-8322FDF906, PT-B3B7D355CB, PT-D453C7A90A | node teamChatCoordinator.test.ts:540, :582, :592, :607 | [FX-BE-181](fx-be-181-provider-context.md) | links refreshed (three were already stale) |
| PT-0AA1A09AEC, PT-3C03B20D14, PT-122958093E, PT-EFAC0E337F, PT-9C568AE082, PT-804A2C0AC4, PT-E116B00BE3 | node teamChatCoordinator.test.ts:655, :668, :686, :708 (×2), :722, :729 | [FX-BE-182](fx-be-182-interruption-recovery.md) | links refreshed |
| PT-D81B94C6F4, PT-824F86BCDF, PT-BCE1A74F9A | node teamChatCoordinator.test.ts:752, :772, :789 | [FX-BE-183](fx-be-183-renderer-migration.md) | links +95 |
| PT-F19C6CE02C | node teamChatCoordinator.test.ts:800 | [FX-BE-184 release proof](fx-be-184-release-proof.md) | link 705→800 |

`fx-be-184-verification-report.md` and `fx-be-184-retained-evidence.md` quote old coordinator line numbers (`:65`, `:300`, `:445`, `:466` …). Both are historical records of a past run, so they were left as written.

### Acceptance criteria → contracts

| Criterion | Contracts |
| --- | --- |
| Two simultaneous sends produce distinct FIFO queued turns; repeated delivery of one command produces one turn | PT-E6F300480C (core, deferred repository), PT-E64E01B995 (main, real file repository), PT-126F6268D2 (sequential redelivery) |
| Selected members answer dev, qa, security, product, lead; mention selects only that member; empty roster resolves to lead | PT-77195EEA97 |
| Response plan committed before dispatch | PT-77195EEA97 (plan read from the repository while the first member is held) |
| Later members see earlier committed replies from their turn; no member sees queued future user messages | PT-D5716B75D8 |
| Roster or runtime default changes affect later accepted turns only | PT-C77A052502 (see finding 1) |
| Failures pause the current turn and leave later turns queued | PT-5F483231F9 |
| One active turn per conversation | PT-5F483231F9 (queued turn never dispatched while the failed turn holds the slot), PT-E6F300480C and PT-C77A052502 (dispatch order is strictly per turn) |

## Findings

1. **Changing the roster: "later turns take the new roster" is not proved (ambiguous).** PT-C77A052502 edits qa's instructions after turns 1 and 2 are accepted. It then proves those turns keep the old instructions. But turn 3 selects only lead, so no later turn ever runs qa with the edited instructions. The assertion "A later accepted turn takes the new roster" only checks the selection (`['lead']`). The runtime default half (`model-v2` on turn 3) is fully proved. A turn 3 that selects qa and asserts `Edited QA instructions` would close this.
2. **"Empty roster resolves to lead" covers an empty selection only.** PT-77195EEA97 sends with `selectedParticipantIds: []` on a conversation that has all five members. A conversation with no participants, or without a lead, is not exercised. The ticket wording supports either reading.
3. **"Pause" means the `failed` state plus an explicit retry.** PT-5F483231F9 asserts `failed` for the current turn and resumes with `retryParticipant`. There is no separate `paused` state. The contract records what the test asserts.
4. **PT-C8CB367EC7 was stale before this stage.** The test was renamed (`60982f33`) to "cancellation preserves unresolved execution as unknown", so the old id matched no source. It is retired and replaced by PT-91F0C03FD3. That test accepts either `cancelled` or `outcome_unknown`, so it does not pin the result of cancelling an in-flight turn.
5. **PT-126F6268D2 (TASK-479 AC1) is weak.** It compares the two turn IDs twice and does not simulate an IPC timeout. Sequential redelivery is now also covered by PT-E6F300480C.
6. **No renderer or e2e evidence for TASK-478.** Concurrency is proved at the core and main service level. No Playwright test sends twice at once from the UI. That is consistent with the change, which touched no UI.
7. **Stale line hints carried over (not fixed, out of scope).** There are 12, all in files TASK-478 did not change. Their ids and titles are intact.
   - Six FX-BE-181 links into `teamChatBindings.test.ts` / `teamChatContext.test.ts` (off by 1–2 lines).
   - Six FX-BE-182 recovery-matrix links into `teamChatRecovery.test.ts` (line 7, now line 6).
   - TASK-476 finding 6 and TASK-477 finding 6 already reported these.
8. **Node contracts are outside the generator.** `praxis-test-catalog.cjs` indexes Playwright only. For the Node contracts, the evidence is the source audit and the executed `node --test` runs above, not the validator.
