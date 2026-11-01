# test-contracts

Ticket: PRX-T113-497 — TASK-497: Implement notes persistence and typed IPC.
Frozen implementation: `20ddf0f8e93ab69502d0bbcb5322b30c699d8ce3` (iteration 2 of 3; it was the checkout HEAD when this stage ran, so no export was needed).

## Outcome

The deterministic validator passes: **734 Playwright contracts catalogued and linked**, with no line-drift warnings. The task contributes **1 Playwright test** and **14 node:test tests** (11 fixed titles plus 3 cases from one parameterized call). The documented union for this task is **15 contracts**. That is not a full monorepo count: the generator indexes only Playwright.

Since the last contracts stage (`62c4f83d`), Implement changed only `notesStore.test.ts`. That made two node:test contracts stale. Both are fixed here (see finding 1). The generated catalog needed no change.

Coverage links: [generated catalog](catalog.json), [automation index](index.md), [14 TASK-497 node:test contracts](task-497-notes.md), [generator/validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs), [e2e spec](../../apps/praxis-desktop/main/e2e/notes.spec.ts), [unit tests](../../apps/praxis-desktop/main/src/main/notesStore.test.ts).

## QA feedback from iteration 1: 189 of 189 smoke tests failed

**Addressed by investigation; no code was changed.** The evidence shows the failure came from the environment, not from TASK-497:

- Every smoke test failed, across 48 unrelated spec files. A regression in a new IPC slice would not stop every window from opening. The only startup change is one `registerNotesIpc()` call, which registers handlers and does no I/O. The store loads lazily on first use.
- `pmset -g log` shows the macOS display was **off from 01:47:53 to 09:06:12 UTC**. The previous stage committed at 02:04, so the QA run fell inside that window. A whole-suite failure while the display is asleep is a known pattern on this machine: Electron windows never reach `firstWindow`.
- With the display on, at this snapshot:
  - the four spec files that failed most in QA all pass with `--project=smoke`: `app.spec.ts`, `newIssue.spec.ts`, `editIssue.spec.ts`, `folderMulti.spec.ts`, **27 passed, 0 failed**. All 27 had failed in QA.
  - `notes.spec.ts` plus `folder.spec.ts` with `--project=functional`: **4 passed**. That includes PT-3C92E05E68, which could not be run at all in the previous stage.

The remaining 161 smoke tests were not rerun here. The full smoke run belongs to QA, and it should run with the display awake.

## Analysis before edits

Diffed `62c4f83d..20ddf0f8`: one file, `notesStore.test.ts`. The backwards-clock test went from a queue of timestamps to an explicit clock variable the test steps back itself. It now also asserts that the group has no members after `deleteNote`, and no longer asserts that the file exists. The test shrank by two lines, so the next test moved from line 225 to 223. Recomputed every TASK-497 ID with the SHA1(file + newline + title) formula: no titles changed, so no IDs changed. Rechecked every link in `task-497-notes.md` against the source; the 14 line numbers now match. `notes.spec.ts`, the store, IPC, preload and core contracts are byte-identical to what the last stage reviewed, so PT-3C92E05E68 and the other 12 node:test contracts still hold.

## Changes

- `task-497-notes.md`:
  - The frozen-source reference now points to `20ddf0f8`.
  - **PT-7AB52FB741**: Given/When/Then rewritten to match the new assertions. It now covers the explicit clock and the empty group after delete, and no longer claims a file-exists check.
  - **PT-CE269CF17F**: link moved from line 225 to 223.
- This report replaces the iteration-1 report.
- `catalog.json` / `index.md`: no change needed (the validator was already clean).

No product code, tests, generator or workflow definition was changed.

## Requirement coverage

| TASK-497 requirement | Contract evidence | Limits |
| --- | --- | --- |
| CRUD | PT-922ACE7DB3, PT-3C92E05E68 | Every store method is unit-tested. Over real IPC, only list, createNote, updateNote, deleteNote, createGroup and onChanged are exercised. |
| Membership operations | PT-922ACE7DB3, PT-332E268E96, PT-F6E2585D72, PT-7AB52FB741 | `replaceMemberships` is proved at store level only. |
| Atomic saves | PT-96B828D1AA, PT-F6E2585D72, PT-DAAFD76BFA | Proves rename failure, temp-file cleanup, memory unchanged after a failure, one write per delete, and queued concurrent writes. See finding 4. |
| Change notifications | PT-922ACE7DB3, PT-96B828D1AA, PT-332E268E96, PT-DAAFD76BFA, PT-3C92E05E68 | Counts per mutation, none on failure/rejection/read/snapshot, unsubscribe over IPC. Event order is not asserted. |
| Restart restoration | PT-922ACE7DB3, PT-04C7D12B91, PT-D561C40BDB, PT-7AB52FB741, PT-3C92E05E68 | The e2e test relaunches the real app on the same profile; it passed in this stage. |
| Group removal keeps notes; note deletion cleans memberships | PT-F6E2585D72, PT-7AB52FB741, PT-3C92E05E68 | Group deletion over IPC is not exercised. |
| Reject cross-project access | PT-899DBBA933, PT-3C92E05E68 | All nine operations at store level; deleteNote and list over IPC. |
| Failed writes | PT-96B828D1AA, PT-CE269CF17F | Rename failure and a transient read failure only. |
| Existing-data startup and malformed data | PT-04C7D12B91, PT-CDBBA295F5, PT-6C3A61B2C1, PT-16907A2B00 | |
| Scheduled runs excluded | n/a | Nothing in the diff touches scheduling. |

## Findings: stale, uncovered and ambiguous contracts

1. **Two stale contracts at the frozen snapshot (fixed here).** PT-7AB52FB741 described the old assertions: it claimed a file-exists check that was removed, and did not mention the new empty-membership check. PT-CE269CF17F linked to line 225 instead of 223. The validator cannot see either, because it does not index node:test.
2. **The QA failure in iteration 1 was environmental (display asleep).** See the QA section above. QA should rerun with the display awake.
3. **The e2e journey is outside the smoke set.** Governed workflow QA runs `test:desktop:smoke`, so PT-3C92E05E68 does not run there; only the full `test:desktop` runs it. The spec uses no hover, mouse or screenshots, so it would qualify for the smoke set. Adding it is a later decision, not one for this stage.
4. **"Atomic" is proved only in part.** PT-96B828D1AA checks the in-memory list after a failed rename, not the bytes on disk. No test reads `notes.json` back after a failure or simulates a crash between write and rename.
5. **IPC handlers with no transport test.** `notes:updateGroup`, `notes:deleteGroup`, `notes:replaceMemberships` and `notes:prepareSnapshot` are covered only by store tests. Each is a one-line pass-through, so the risk is low, but only five of the nine channels are tested over IPC.
6. **The e2e notification assertion is loose.** It checks five events, each equal to project A or B, but not which project each event belongs to or their order.
7. **The e2e title says "round-trip"** but asserts restored titles and bodies only, not IDs, timestamps or the order of group members across the relaunch. Order across a reload is proved by PT-922ACE7DB3 at store level.
8. **Documented but untested boundary.** Removing a project leaves its notes in the file, unreachable (`notesStoreInstance.ts`). There is no test, as intended.
9. **Generator limits carried over:** node tests are not indexed; titles built from template literals with expressions are skipped; every entry is labelled `project: functional`. The validator checks identity and that the flow fields are filled, not whether the prose is true. Most of the 734 entries still carry the generic Then text.

## Verification

| Check performed in this stage | Result |
| --- | --- |
| `npm run test:praxis-contracts` at the frozen snapshot | Passed: 734 catalogued and linked. |
| Manual link and ID audit of `task-497-notes.md` | 2 stale contracts found, both fixed; all 14 IDs recomputed and unchanged. |
| `npm run test:praxis-contracts` after edits | Passed: 734 catalogued and linked, no warnings. |
| `npm run compile` (desktop main, including `check-ipc-senders`) | Passed. |
| `node --test out/main/notesStore.test.js` | 14 passed, 0 failed/skipped. |
| `npx playwright test e2e/notes.spec.ts e2e/folder.spec.ts --project=functional` | 4 passed. |
| `npx playwright test e2e/app.spec.ts e2e/newIssue.spec.ts e2e/editIssue.spec.ts e2e/folderMulti.spec.ts --project=smoke` | 27 passed (all 27 had failed in iteration-1 QA). |

No UI changed, so no visual verification was needed and no screenshot was captured. No stage was advanced, the workflow was not edited, and no tracker was changed.
