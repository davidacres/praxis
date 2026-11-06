# test-contracts — PRX-T111-486 / TASK-486

Stage: **WF-0742A955-test-contracts**. Frozen implementation: `b363f41ab5d98c2bba77f484817c428af0129cde` ("crash-during-Stop recovery and failure-matrix coverage"). At entry the worktree HEAD matched it and was clean. This stage changes catalog documentation only.

## Result

- **Playwright catalog:** `npm run test:praxis-contracts` exit 0 before and after editing: **804 Playwright tests catalogued and linked**, no warnings. TASK-486 changed no Playwright spec, so `catalog.json` / `index.md` are unchanged.
- **TASK-486 Node contracts:** **4 source contracts, 5 runtime cases**, one per `test(...)` added or renamed in b363f41a. The implement stage wrote them; this stage checked each one against its test body.

  | Id | Test (file:line) | Runtime cases | Kind |
  | --- | --- | --- | --- |
  | PT-BAFAF71874 | `teamChatCrashBoundaries.test.ts:369` crash while a turn is cancelling… `${capability}` | PT-84EF0A45E2 (`text-only`), PT-57F44DA3DF (`tool-capable`) | new, parameterised |
  | PT-3819088619 | `teamChatCrashBoundaries.test.ts:411` a final result persisted for a cancelling turn imports exactly once… | 1 | new |
  | PT-6A2E85CA23 | `teamChatIpcRecovery.test.ts:384` a Stop interrupted by process exit stays stopped after restart on the file repository | 1 | new |
  | PT-C5D91CE0A1 | `acpAgentHost.test.ts:593` durable ACP continuation … advertised but failing | 1 (three modes in one test) | renamed |

- **Renamed test:** b363f41a renamed the durable ACP continuation test. The id comes from the title, so **PT-1AE4FF6CEF is retired** and **PT-C5D91CE0A1** replaces it in [FX-BE-181](fx-be-181-provider-context.md#pt-c5d91ce0a1). The [release proof](fx-be-184-release-proof.md#task-486-failure-matrix-additions) lists it again as a cross-reference (marked "Supersedes"). Count it once.
- **Ids recomputed:** SHA1(file + newline + title) matches for all four source ids and both expanded runtime ids.
- **Prose corrected:** PT-BAFAF71874 said "the second restart changes nothing". The test compares only turn states and dispatch count after the second restart. The prose now says that, and also states the asserted "no assistant message is written".
- **Source audit** (scratch script in the system temp directory; checks the id, the exact title at the linked line, and that the file exists) over every `##`/`###` `PT-` contract under `docs/praxis-tests`: **167 pass, 24 flagged**. The same audit at `cf787348`, before TASK-486, gives **163 pass, the same 24 flagged**. TASK-486 added 4 passing entries and introduced no stale entries. The 24 are listed under Findings.
- **Focused runs (executed at b363f41a in this stage):**
  - `cd packages/core && npx tsc -p . && node --test --test-reporter=tap out/ai/assistant/teamChatCrashBoundaries.test.js out/ai/acp/acpAgentHost.test.js` — **44 passed, 0 failed, 0 skipped**. Includes `ok 26` (ACP rename) and `ok 42–44` (the three new crash cases).
  - `cd apps/praxis-desktop/main && npm run compile && node --test --test-reporter=tap out/main/teamChatIpcRecovery.test.js` — **14 passed, 0 failed, 0 skipped**. Includes `ok 14` (Stop across restart).
  - Registration: all three files are already in the explicit npm lists: core `test` (`teamChatCrashBoundaries`, `acpAgentHost`) and main `test:git` (`teamChatIpcRecovery`). No new file was added.
- **Fixture isolation (new tests):** the core crash cases are in memory (`CrashableRepository`). The ACP case writes under `mkdtemp(tmpdir(), 'praxis-durable-acp-')`. The main case writes `team-chats.json` under `mkdtempSync(tmpdir(), 'praxis-chat-recovery-')`, which `t.after` removes. None of them writes to working-tree plans, `*.praxis.*` files or user data.
- **Not run (scheduled-run policy):** full functional and theme e2e suites, the live API check (no `PRAXIS_LIVE_API_PROVIDER` / `PRAXIS_LIVE_API_KEY`), real CLI continuation, and manual or visual passes. No UI changed, so no screenshot was taken.

## Coverage by ticket acceptance criterion

| Criterion | Evidence | Status |
| --- | --- | --- |
| Every feature AC maps to a named assertion and artifact; no skipped test reported as passed | [Verification report, TASK-486 section](fx-be-184-verification-report.md#task-486-failure-matrix-2026-11-06) maps AC1–AC12 by test title. The focused reruns above show 0 skipped. | Covered (deterministic). Rows marked "e2e (historical)" were not rerun. |
| File-write errors, malformed data, duplicate commands/events, concurrent windows, missing provider resume, every crash boundary | New here: crash during Stop (PT-BAFAF71874 ×2, PT-3819088619, PT-6A2E85CA23) and resume advertised but failing (PT-C5D91CE0A1). The other categories rely on existing FX-BE-180…184 contracts, listed in the report's "Failure categories" table. | Covered (deterministic) |
| Temporary profiles, repositories and coordination roots only | Isolation check above for the new tests; the report's isolation audit covers the rest. | Covered |
| Opt-in real API and real CLI continuation/restart with retained attempt ids | No contract claims it. Not run: credentials were not provided, and live checks are optional in scheduled runs. No mock was used in its place. | **Not run**, open |

## Findings

1. **Stale before TASK-486 (unchanged here, out of scope):** [FX-BE-180](fx-be-180-coordinator.md) PT-1A2365951E ("TASK-479 AC2: Subscription emits revision updates") and PT-91F0C03FD3 ("TASK-479 AC4: cancellation preserves unresolved execution as unknown") name titles that no longer exist in `teamChatCoordinator.test.ts`. Each needs a decision: re-point it to the replacement test or retire it.
2. **Line drift before TASK-486 (14 entries):** FX-BE-180 PT-F4C7E562E3 (447→453) and 13 in [FX-BE-181](fx-be-181-provider-context.md): PT-ACA148E624, PT-9DCCCF8D27, PT-0A0EAED4F7, PT-86B267D61F, PT-A7F41C3F50, PT-E4566B69A9, PT-36D88646CB, PT-8322FDF906, PT-B3B7D355CB, PT-D453C7A90A, PT-45452EE422, PT-A5EB5F0D9C, PT-9091C3E855. Each title still exists in its file, so the id is valid and only the link is off. The drift is identical at `cf787348`.
3. **The audit's 8 FX-BE-182 entries are not stale:** they are expanded runtime ids for parameterised tests (`startup recovery matrix: …`, `startup imports durable results once …: ""`), whose source titles are concatenations.
4. **Release-proof header count:** the header says "30 supplemental source contracts" (27 + 3). The file now has 33 `### PT-` headings: the 2 strengthened re-listings, the PT-EE0AB4E23D Playwright cross-reference and the PT-C5D91CE0A1 cross-reference account for the rest, with the earlier mismatch of one (TASK-485 finding 5) carried forward. Left as is.
5. **PT-C5D91CE0A1 runs three modes in one test.** A failure in the "advertised but failing" mode reports under the shared title (the `state` assertion carries the mode as its message; the prompt and delivery assertions do not).
6. **AC "real API / real CLI continuation" remains open.** Native CLI session reuse is still unproven, and the pending-approval `outcome_unknown` vs design-matrix `interrupted` discrepancy is still open, as the verification report records.
