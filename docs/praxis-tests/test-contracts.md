# test-contracts

Ticket: PRX-T113-502 — TASK-502: Add persistence and end-to-end regression coverage.
Frozen implementation: `202bb056fe6f7f0cbb65ef109d9b124475f53551`. It was the checkout HEAD when this stage ran, with a clean tree, so no export was needed.

## Outcome

The validator passed at the frozen snapshot: **766 Playwright contracts catalogued and linked**, no stale links, no duplicate ids, no line-drift warnings. The implement stage had already regenerated the inventory. This stage replaced placeholder or overstated prose on 6 entries. After `--write` (766 carried over) the validator still passes at **766**.

TASK-502 adds **18 Playwright tests and 3 node:test tests**:

- **14 Playwright tests are in the catalog** (752 after TASK-501, 766 now): 7 in `notesPersistence`, 4 in `notesShelfGeometry`, 2 in `sidebarNotes`, 1 in `noteSessionHandoff`.
- **4 Playwright tests are not in the catalog.** They are the parameterised `notesShelfGeometry` cases (compact and large rail, light and dark colour scheme). The generator skips template-literal titles. They are described, without ids, in [task-502-notes.md](task-502-notes.md).
- **3 node:test tests** in `notesStore.test.ts` are in [task-502-notes.md](task-502-notes.md). Their ids were recomputed with the SHA1(file + newline + title) convention and match.

Coverage links: [generated catalog](catalog.json), [automation index](index.md), [TASK-502 supplemental contracts](task-502-notes.md), [generator/validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs), specs [notesPersistence](../../apps/praxis-desktop/main/e2e/notesPersistence.spec.ts), [notesShelfGeometry](../../apps/praxis-desktop/main/e2e/notesShelfGeometry.spec.ts), [sidebarNotes](../../apps/praxis-desktop/main/e2e/sidebarNotes.spec.ts), [noteSessionHandoff](../../apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts), store tests [notesStore.test.ts](../../apps/praxis-desktop/main/src/main/notesStore.test.ts).

| ID | Runner | Automation | Test |
| --- | --- | --- | --- |
| PT-FA51ED8FDB | playwright | `apps/praxis-desktop/main/e2e/notesPersistence.spec.ts:17` | every notes channel resolves a typed result for bad input, a foreign project or a foreign note |
| PT-E5F2DCBB1C | playwright | `apps/praxis-desktop/main/e2e/notesPersistence.spec.ts:59` | onChanged fires once per mutation with the project id, and never for reads |
| PT-36C563F01A | playwright | `apps/praxis-desktop/main/e2e/notesPersistence.spec.ts:87` | a restart restores notes from both surfaces, the group and its order |
| PT-0B84FC3A29 (prose corrected) | playwright | `apps/praxis-desktop/main/e2e/notesPersistence.spec.ts:136` | a failed save never reports saved, and a restart keeps the last committed text |
| PT-F825F0D43D | playwright | `apps/praxis-desktop/main/e2e/notesPersistence.spec.ts:168` | notes stay in their own project, in the sidebar, the store and the file |
| PT-CE216214B3 (prose corrected) | playwright | `apps/praxis-desktop/main/e2e/notesPersistence.spec.ts:200` | ungrouping and deleting persist across a restart; cancelling a delete changes nothing |
| PT-E705B57437 | playwright | `apps/praxis-desktop/main/e2e/notesPersistence.spec.ts:244` | ordinary note actions never call a provider or create a session |
| PT-74DEC0CE31 (prose added) | playwright | `apps/praxis-desktop/main/e2e/notesShelfGeometry.spec.ts:80` | a full rail keeps its width and keeps both controls reachable inside it |
| PT-2E308B7C65 (prose added) | playwright | `apps/praxis-desktop/main/e2e/notesShelfGeometry.spec.ts:111` | keyboard focus on a control does not move the rail or the workspace, and the ring stays inside |
| PT-2BEF880E16 (prose added) | playwright | `apps/praxis-desktop/main/e2e/notesShelfGeometry.spec.ts:138` | the open notes card is the only part that reaches into the workspace |
| PT-B20CB25D7D (prose added) | playwright | `apps/praxis-desktop/main/e2e/notesShelfGeometry.spec.ts:173` | whole-window zoom at 110% leaves the rail 14 x scale in CSS pixels |
| PT-16C2B2785B | playwright | `apps/praxis-desktop/main/e2e/sidebarNotes.spec.ts:110` | an edit made in the shelf shows under every group in the sidebar, once per membership |
| PT-22A558A1FC | playwright | `apps/praxis-desktop/main/e2e/sidebarNotes.spec.ts:152` | the sidebar editor reports a failed save, keeps the text and recovers on Retry |
| PT-CAF9491769 | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:228` | a single note sends once to an existing session as a one-note reference; cancelling sends nothing |
| PT-EE0D9251E0 | node:test | `apps/praxis-desktop/main/src/main/notesStore.test.ts` | a stray temp file from an interrupted write is ignored, and the last committed data loads |
| PT-38B10457B6 | node:test | `apps/praxis-desktop/main/src/main/notesStore.test.ts` | ungrouping persists across a restart: the note stays, the other group and the order are unchanged |
| PT-9ADEFD3FA6 | node:test | `apps/praxis-desktop/main/src/main/notesStore.test.ts` | deleting a note persists across a restart: no group in any project still points at it |
| — (uncatalogued) | playwright | `apps/praxis-desktop/main/e2e/notesShelfGeometry.spec.ts:55` | the compact / large rail is 14 x scale wide, matches the baseline and leaves the workspace inset alone (2 cases) |
| — (uncatalogued) | playwright | `apps/praxis-desktop/main/e2e/notesShelfGeometry.spec.ts:156` | the rail measures the same under a light / dark colour scheme (2 cases) |

## Acceptance coverage (ticket → contract)

| Ticket asks for | Covered by |
| --- | --- |
| Capture on both surfaces | PT-36C563F01A (sidebar note and shelf note, both survive restart) |
| Linked edits | PT-16C2B2785B |
| Ungrouping, deletion | PT-CE216214B3, PT-38B10457B6, PT-9ADEFD3FA6, PT-0754F5395E (existing) |
| Project isolation | PT-F825F0D43D, PT-FA51ED8FDB |
| Restart | PT-36C563F01A, PT-CE216214B3, PT-0B84FC3A29 |
| Autosave errors | PT-22A558A1FC (sidebar, Retry), PT-0B84FC3A29 (shelf), PT-EE0D9251E0 (store) |
| Explicit single / group send | PT-CAF9491769 (single), PT-35D3A2F43C (group, existing) |
| No provider calls on save / group / open / cancel | PT-E705B57437, PT-90ABEBFC94 (existing), PT-CAF9491769 (cancel) |
| Rail geometry and workspace inset against the baseline | uncatalogued compact/large cases, PT-74DEC0CE31, PT-2E308B7C65, PT-2BEF880E16, PT-B20CB25D7D (see finding 2) |
| Pointer / hover / screenshot cases kept out of smoke | `notesPersistence` joined `SMOKE_SPECS` and uses only `click()` and the keyboard; `notesShelfGeometry` (screenshots) is not in smoke. A grep for hover, `page.mouse`, drag and `toHaveScreenshot` in the three smoke-eligible note specs found nothing. |

## Changes in this stage

- `catalog.json`: `flow` prose only. No ids, titles or links changed. `index.md` was regenerated and is byte-identical.
  - PT-74DEC0CE31, PT-2E308B7C65, PT-2BEF880E16, PT-B20CB25D7D: these still had generic placeholder prose. Each now states the fixture, the action and the measured tolerances, and records where the title says more than the test checks.
  - PT-0B84FC3A29: the old Then said "the file holds only committed text, and the note reopens with its last committed text". Neither is proved (finding 1), so the contract now says what is actually asserted.
  - PT-CE216214B3: the old Given said "one note in two groups plus another note". In fact both notes are in both groups, in opposite orders. The Given now says so, and the Then names the exact memberships asserted.
- `test-contracts.md`: this report. It replaces the TASK-501 report, which stays in git history.

## Findings (stale, ambiguous or weak contracts)

1. **PT-0B84FC3A29 does not check what the app wrote.** The "committed file holds only what was really saved" check runs *after* `restore()`, which writes back the test's own copy of the file. After relaunch it only asserts that the text *contains* "safe line". The check that the text does not read Saved applies only if the unsaved text came back. So "a restart keeps the last committed text" is not strictly proven. To prove it, read the file before restoring, or assert that the body after relaunch equals "safe line".
2. **The geometry "baseline" is a stand-in, not the pre-change build.** The ticket asks for checks "against the pre-change baseline". The spec measures the current build with `.session-shelf__actions` hidden by an injected style, plus the old `14 x --ui-scale` formula. That is a reasonable proxy, but it does not catch a change to the shelf's own padding or border made in the same diff.
3. **4 parameterised geometry tests are missing from the generated inventory**, including the main baseline comparison at scales 1 and 1.16. This is a known generator limitation. They appear only in `task-502-notes.md`, with no stable ids, so QA's count of 766 under-reports TASK-502 coverage by 4.
4. **PT-2BEF880E16's title says more than the test checks.** "The only part that reaches into the workspace" is not checked: the test checks only where the sleeve starts and that the rail and pane did not move.
5. **PT-F825F0D43D's sidebar check is loose.** It asserts that exactly one of the two project titles is visible, not which one belongs to the active project. The IPC and file assertions are exact.
6. **PT-FA51ED8FDB accepts any of three codes** (`NOTE_NOT_FOUND`, `PROJECT_MISMATCH`, `GROUP_NOT_FOUND`) for each cross-project call. It proves the call is refused and B's data is intact, but not which refusal each channel returns.
7. **PT-E5F2DCBB1C's "never for reads" depends on timing.** It waits 150 ms before counting events, so a late event would be missed rather than fail the test.
8. **The project label is wrong for the new smoke spec.** Every entry is labelled `project: functional`. `notesPersistence` now also runs in the smoke project. This is the known generator gap.
9. **The colour-scheme geometry cases only emulate `prefers-color-scheme`.** They do not switch the app's theme setting. They write `notes-rail-<scheme>.png` to `.praxis/session-artifacts/`, which is git-ignored, so nothing leaks into the tree.

## Verification

- `npm run test:praxis-contracts` at 202bb056 before editing: `Praxis Tests: 766 Playwright tests catalogued and linked.`
- `npm run test:praxis-contracts -- --write`: `Wrote 766 Praxis Test contracts … (766 existing contracts carried over).`
- `npm run test:praxis-contracts` after editing: `Praxis Tests: 766 Playwright tests catalogued and linked.` No warnings.
- The test suites themselves were not run in this stage. Contracts were checked by reading each test's assertions against its prose. No visual verification was performed, and no screenshot was captured.
