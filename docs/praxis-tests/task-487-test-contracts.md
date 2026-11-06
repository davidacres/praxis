# test-contracts — PRX-T111-487 / TASK-487

Stage: **WF-05CD601E-test-contracts**. Frozen implementation: `163701ffc0fdcc86371ac41df9c79fbe5b1f1ac2` ("notify every committed team-chat revision; release verification"). At entry the worktree HEAD matched it and was clean. This stage changes catalog documentation only.

## Result

- **Playwright catalog:** `npm run test:praxis-contracts` exit 0 before and after editing: **806 Playwright tests catalogued and linked**, no warnings. `praxis-test-catalog.cjs --write` reproduces the file byte for byte (806 carried over), so the curated flows survive regeneration.
- **New Playwright contracts (2):** the implement stage regenerated the catalog but left both new entries with the generator's placeholder flow ("the automated assertions for this test pass…"). This stage replaced them with Given / When / Then written from the test bodies.

  | Id | Test (file:line) | Set |
  | --- | --- | --- |
  | PT-748A90EE31 | `durableTeamChat.spec.ts:718` an over-budget current request pauses as context_required; Recheck context stays actionable and Stop cancels it | smoke + functional |
  | PT-AEDE2C68C0 | `durableTeamChatJourney.spec.ts:30` journey: float and dock, sidebar row, queue and cancel, Stop, restart mid-reply, retry, transcript and usage survive | functional only |

- **New Node contract (1):** PT-F7F4DAD4AF, `teamChatCoordinator.test.ts:455` "every committed revision reaches subscribers, so a control at the last notified revision applies". Added to [the release proof](fx-be-184-release-proof.md#task-487-release-verification-additions), which now counts it.
- **Ids recomputed:** SHA1(file + newline + title). The formula reproduces the existing PT-BAFAF71874, and gives PT-F7F4DAD4AF for the new Node test. The two Playwright ids come from the generator.
- **Line drift caused by TASK-487, fixed:** the regression test inserted 30 lines into `teamChatCoordinator.test.ts` at line 453, which moved 9 hand-written links below it. Each title still exists, so the ids are unchanged; only the line anchors were moved +30:
  - [FX-BE-182](fx-be-182-interruption-recovery.md): PT-0AA1A09AEC, PT-3C03B20D14, PT-122958093E, PT-804A2C0AC4, PT-E116B00BE3
  - [FX-BE-183](fx-be-183-renderer-migration.md): PT-D81B94C6F4, PT-824F86BCDF, PT-BCE1A74F9A
  - [FX-BE-184 release proof](fx-be-184-release-proof.md): PT-F19C6CE02C
- **Source audit** (scratch script in the system temp directory; checks that the file exists, the id matches, the title is present, and the linked line holds it) over every `##`/`###` `PT-` contract: at `d3cc37ed` (before TASK-487) **162 pass, 62 flagged**; at `163701ff` **153 pass, 71 flagged** (the 9 above); after this stage **163 pass, 62 flagged**. The 62 are the same set as before TASK-487. This audit checks line numbers more strictly than TASK-486's (which reported 167/24), so the counts are not comparable between the two reports; the before/after delta is.
- **Focused runs (executed in this stage at 163701ff plus these doc edits):**
  - `cd packages/core && npx tsc -p . && node --test --test-reporter=tap out/ai/assistant/teamChatCoordinator.test.js`: **29 passed, 0 failed, 0 skipped**, including `ok 8` (the new regression test).
  - `npm run build` (core → renderer → copy-renderer → desktop): exit 0.
  - `cd apps/praxis-desktop/main && npx playwright test --project=functional e2e/durableTeamChatJourney.spec.ts e2e/durableTeamChat.spec.ts -g "over-budget current request|journey: float and dock" --reporter=list`: **2 passed** (4.2 s, 12.0 s).
- **Fixture isolation:** both e2e tests use `launchTestApp` temporary profiles and a mock provider. The journey's project points at the temporary user-data directory. Both write screenshots into `.praxis/session-artifacts/`, which is git-ignored (`.gitignore:87`); neither writes plans, `*.praxis.*` files or user data.
- **Not run (scheduled-run policy):** full functional and theme e2e suites, the live API / real CLI checks (`durableTeamChat.live.spec.ts`; no credentials), and manual or visual passes. No UI changed in this stage, so no screenshot was taken here; the implement stage's captures are listed in the [verification report](fx-be-184-verification-report.md#visual-evidence).

## Coverage by ticket acceptance criterion

| Criterion | Evidence | Status |
| --- | --- | --- |
| Prescribed commands pass, or have explicit blocker evidence | [Verification report, TASK-487 section](fx-be-184-verification-report.md#task-487-release-verification-2026-11-06) records every command and exit code. Rerun here: the core suite and the two new e2e tests. | Covered for focused checks. Full suites and live checks **not run**; recorded as such, not as passed |
| Manual verification: dock/float, sidebars, second window, restart, permissions, queue, cancel/retry, context_required, outcome_unknown | PT-AEDE2C68C0 drives sidebar row, float → dock, queue, cancel, Stop, SIGKILL restart and retry. PT-748A90EE31 drives context_required. Second window, permissions and outcome_unknown rely on existing `durableTeamChat.spec.ts` contracts (PT-6A15DADEFB and others), not re-driven by hand. | Partly covered (automated). Hand-driven pass for second window, permissions and outcome_unknown **not done**. "Both sidebars" is not applicable (classic tree removed in f977690f) |
| Screenshots under `.praxis/session-artifacts/`; snapshot updates inspected | Both specs write captures there. No `toHaveScreenshot` baseline changed, so there is no actual/diff to inspect. | Covered for the captures the specs produce |
| Report separates deterministic, real-provider, full-suite and visual evidence; user data intact; rollback documented | The verification report has one section for each, plus "User data and rollback". | Covered (documentation) |

## Findings

1. **Placeholder flows (fixed):** the implement stage's `--write` gave both new catalog entries the generator's default flow. That flow claims nothing specific and would have hidden what the tests prove. Both are now curated.
2. **Line drift from TASK-487 (fixed):** 9 entries, listed above.
3. **PT-AEDE2C68C0 "usage survive" is a weak check.** After restart it asserts only that `session-usage-summary` contains "tok", not that the value matches the value before restart. The contract says "a token usage summary is read back", not "usage is preserved exactly".
4. **PT-AEDE2C68C0 step 7 checks "All projects" through IPC, not the UI.** It asserts `listChats(project) + listChats('') === 1`. The sidebar row in "All projects" scope is not looked at. The verification report's "listed once across project and All projects scope" should be read that way.
5. **Docking after SIGKILL is not asserted.** The journey only checks that the panel is visible after the crash, because a SIGKILL can lose unflushed localStorage. Whether docking is kept after a crash is not covered.
6. **The smoke-set test writes a file into the checkout.** PT-748A90EE31 is in `SMOKE_SPECS` and saves `fx-be-184-context-required.png` under the repo's `.praxis/session-artifacts/` on every smoke run. The folder is git-ignored and this is not a Praxis write path, but it is a side effect on the working tree that unattended runs will repeat.
7. **Still open from TASK-486 (unchanged here):** FX-BE-180 PT-1A2365951E and PT-91F0C03FD3 name titles that no longer exist; 14 pre-existing line drifts (TASK-486 finding 2) remain; the release-proof header count mismatch (TASK-486 finding 4) carries forward.
8. **Feature acceptance stays open:** real API and real CLI continuation not run, native CLI session reuse unproven, and the pending-approval `interrupted` vs `outcome_unknown` discrepancy unresolved, as the verification report records.
