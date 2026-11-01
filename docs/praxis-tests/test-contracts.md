# test-contracts

Ticket: PRX-T113-497 — TASK-497: Implement notes persistence and typed IPC.
Frozen implementation: `149c3521c52b6f4f7c8d9fff820b54d94c3e9e08` (the checkout HEAD when this stage ran, so no export was needed).

## Outcome

The deterministic validator passes: **734 Playwright contracts catalogued and linked**, up from 733. The implementation adds **1 Playwright test** and **14 node:test tests** (11 fixed titles plus 3 cases from one parameterized call). The documented union for this task is **15 contracts**. That is not a full monorepo count: the generator indexes only Playwright.

At the frozen snapshot the validator **failed**: it reported `notes.spec.ts:29` as a new test missing from the catalog. Because the root `npm run test` runs `test:praxis-contracts`, the QA stage would have failed on it. This stage fixes that.

Coverage links: [generated catalog](catalog.json), [automation index](index.md), [14 TASK-497 node:test contracts](task-497-notes.md), [generator/validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs), [e2e spec](../../apps/praxis-desktop/main/e2e/notes.spec.ts), [unit tests](../../apps/praxis-desktop/main/src/main/notesStore.test.ts).

## Analysis before edits

Read both implementation commits (`a0a5d15b`, `149c3521`): `notesStore.ts` (lazy load, a single queue, temp file + rename, memory updated only after a successful save, notification after a save with only the project ID, transient read errors retried, unreadable files never overwritten), `notesIpc.ts` (nine `notes:*` trusted handlers that resolve `NotesResult` and never reject), `notesStoreInstance.ts` (`userData/notes.json`, project registry from `ProjectStore`, broadcast `notes:changed`), and the preload bridge. Read both test files in full and checked each contract against its assertions. Confirmed `notesStore.test.js` is registered in `test:git`, which the root `test` reaches through `test:desktop:git`. Confirmed `notes.spec.ts` is in the `functional` project but **not** in `SMOKE_SPECS`.

## Changes

- `catalog.json` / `index.md`: regenerated with `--write`. One entry was added (**PT-3C92E05E68**) and all 733 existing entries carried over unchanged, with no IDs renumbered and no line moves. The new entry's generic flow was replaced with a curated Given/When/Then that matches its assertions.
- `task-497-notes.md`: new supplement holding 14 node:test contracts, using the TASK-496 ID formula.
- This report replaces the TASK-496 report that was here before.

No product code, tests, generator or workflow definition was changed.

## Requirement coverage

| TASK-497 requirement | Contract evidence | Limits |
| --- | --- | --- |
| CRUD | PT-922ACE7DB3, PT-3C92E05E68 | Every store method is unit-tested. Over real IPC, only list, createNote, updateNote, deleteNote, createGroup and onChanged are exercised. |
| Membership operations | PT-922ACE7DB3, PT-332E268E96, PT-F6E2585D72 | `replaceMemberships` is proved at store level only. |
| Atomic saves | PT-96B828D1AA, PT-F6E2585D72, PT-DAAFD76BFA | Proves rename failure, temp-file cleanup, memory unchanged after a failure, one write per delete, and queued concurrent writes. See finding 3. |
| Change notifications | PT-922ACE7DB3, PT-96B828D1AA, PT-332E268E96, PT-DAAFD76BFA, PT-3C92E05E68 | Counts per mutation, none on failure/rejection/read/snapshot, unsubscribe over IPC. Event order is not asserted. |
| Restart restoration | PT-922ACE7DB3, PT-04C7D12B91, PT-D561C40BDB, PT-3C92E05E68 | The e2e test relaunches the real app on the same profile. |
| Group removal keeps notes; note deletion cleans memberships | PT-F6E2585D72, PT-3C92E05E68 | Group deletion over IPC is not exercised. |
| Reject cross-project access | PT-899DBBA933, PT-3C92E05E68 | All nine operations at store level; deleteNote and list over IPC. |
| Failed writes | PT-96B828D1AA, PT-CE269CF17F | Rename failure and a transient read failure only. |
| Existing-data startup and malformed data | PT-04C7D12B91, PT-CDBBA295F5, PT-6C3A61B2C1, PT-16907A2B00 | |
| Scheduled runs excluded | n/a | Nothing in the diff touches scheduling. |

## Findings: stale, uncovered and ambiguous contracts

1. **Stale catalog at the frozen snapshot (fixed here).** The implement stage added `notes.spec.ts` without running `--write`, so `npm run test:praxis-contracts` and therefore the root `npm run test` failed.
2. **The e2e journey is outside the smoke set.** Governed workflow QA runs `test:desktop:smoke`, so PT-3C92E05E68 will not run there; it runs only in the full `test:desktop`. The spec drives the app through `evaluate` with no hover, mouse or screenshots, so it would qualify for the smoke set. Adding it is a decision for a later stage, not this one.
3. **"Atomic" is proved only in part.** PT-96B828D1AA checks the in-memory list after a failed rename, not the bytes on disk. The design makes a partial file impossible (write to a temp file, then rename), but no test reads `notes.json` back after a failure or simulates a crash between write and rename.
4. **IPC handlers with no transport test.** `notes:updateGroup`, `notes:deleteGroup`, `notes:replaceMemberships` and `notes:prepareSnapshot` are covered only by store tests. Each is a one-line pass-through, so the risk is low, but the claim "typed IPC is tested" covers five of the nine channels.
5. **The e2e notification assertion is loose.** It checks five events, each equal to project A or B, but not which project each event belongs to or their order. The unit tests cover exact counts; nothing pins the event-to-project mapping.
6. **The e2e title says "round-trip"** but asserts restored titles and bodies only, not IDs, timestamps or the order of group members across the relaunch. Order across a reload is proved by PT-922ACE7DB3 at store level.
7. **Documented but untested boundary.** Removing a project leaves its notes in the file, unreachable (`notesStoreInstance.ts`). No test exists, as intended; it is recorded here so it is not mistaken for coverage.
8. **Generator limits carried over from earlier stages:** Node tests are not indexed; titles built from template literals with expressions are skipped; every entry is labelled `project: functional`. The validator checks identity and that the flow fields are filled, not whether the prose is true. Most of the 734 entries still carry the generic Then text.

## Verification

| Check performed in this stage | Result |
| --- | --- |
| `npm run test:praxis-contracts` at the frozen snapshot | **Failed**: 1 problem, new test not in the catalog (`notes.spec.ts:29`). |
| `npm run test:praxis-contracts -- --write` | Wrote 734 contracts; 733 carried over. |
| `npm run test:praxis-contracts` after curating | Passed: 734 catalogued and linked, no line-drift warnings. |
| `npm run compile` (desktop main) | Passed, exit 0. |
| `node --test out/main/notesStore.test.js` | Passed: 14 tests, 14 passed, 0 failed/skipped. |
| `npx playwright test e2e/notes.spec.ts --project=functional` | **Not verified**: 30 s test timeout, then a worker teardown timeout. |
| Control: `npx playwright test e2e/boardSettingsFile.spec.ts --project=functional` | Failed the same way (2 of 2 timed out), so Electron e2e cannot run in this unattended session. This is an environment failure, not evidence against the notes code. |

**PT-3C92E05E68 has not been run successfully in this stage.** Its contract is written from the test source. The QA stage, or a person, should run `npx playwright test e2e/notes.spec.ts` from `apps/praxis-desktop/main` on a machine that can launch Electron, after building and running `copy-renderer`.

No UI changed and no visual verification was needed; no screenshot was captured. No stage was advanced, the workflow was not edited, and no tracker was changed.
