# test-contracts

Ticket: PRX-T113-499 — TASK-499: Add sidebar notes tree and shared editor.
Frozen implementation: `3b721e79682a3b3d61ec9ff5805b159269a9e37a` (it was the checkout HEAD when this stage ran, with a clean tree, so no export was needed).

## Outcome

At the frozen snapshot the validator failed with **2 problems**: two new tests in `sidebarNotes.spec.ts` were missing from the catalog. After `--write` and curated prose for both, it passes: **742 Playwright contracts catalogued and linked** (740 carried over unchanged), with no line-drift warnings.

The task contributes **2 Playwright tests** and **6 node:test tests**, so this task documents **8 contracts**. That is not a full monorepo count, because the generator indexes only Playwright.

Coverage links: [generated catalog](catalog.json), [automation index](index.md), [6 TASK-499 node:test contracts](task-499-notes.md), [generator/validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs), [e2e spec](../../apps/praxis-desktop/main/e2e/sidebarNotes.spec.ts), unit tests [notesSession](../../apps/praxis-desktop/renderer/test/notesSession.test.ts) and [notesTree](../../apps/praxis-desktop/renderer/test/notesTree.test.ts).

| ID | Runner | Automation |
| --- | --- | --- |
| PT-2DFB759892 | playwright | `apps/praxis-desktop/main/e2e/sidebarNotes.spec.ts:39` |
| PT-0754F5395E | playwright | `apps/praxis-desktop/main/e2e/sidebarNotes.spec.ts:81` |
| PT-EF24B1568D | node:test | `apps/praxis-desktop/renderer/test/notesSession.test.ts:74` |
| PT-2DF357AC10 | node:test | `apps/praxis-desktop/renderer/test/notesSession.test.ts:86` |
| PT-8932C374BF | node:test | `apps/praxis-desktop/renderer/test/notesSession.test.ts:97` |
| PT-6DA0575B35 | node:test | `apps/praxis-desktop/renderer/test/notesTree.test.ts:8` |
| PT-A1B52A5EE5 | node:test | `apps/praxis-desktop/renderer/test/notesTree.test.ts:18` |
| PT-1DB2C21417 | node:test | `apps/praxis-desktop/renderer/test/notesTree.test.ts:24` |

## Changes in this stage

- `catalog.json` / `index.md`: regenerated with `--write`, adding the 2 entries. The generic placeholder Given/When/Then was replaced with prose that states only what each test asserts, and records where a title promises more than the test checks.
- `task-499-notes.md`: new; 6 node:test contracts.

No product code, test, generator or workflow definition was changed.

## Requirement coverage

| TASK-499 requirement | Contract evidence | Limits |
| --- | --- | --- |
| Notes section in the sidebar, compact rows | PT-2DFB759892 | EasyMode only. The classic sidebar is no longer rendered (`f977690f`), so "Classic and Easy Mode" now means one sidebar. No test checks the row styling. |
| Expandable named groups | PT-2DFB759892, PT-6DA0575B35 | The e2e test asserts collapse only (`aria-expanded` false). After the second click, nothing checks that the group expanded again. |
| Create note | PT-2DFB759892, PT-0754F5395E | |
| Rename (note or group) | PT-2DF357AC10 | **No e2e coverage** for either rename menu action. The unit test covers renaming the open note only. |
| Membership: add, remove, move (menu-driven) | PT-2DFB759892, PT-A1B52A5EE5, PT-1DB2C21417 | Move up/down is unit-tested only. A note in two groups is unit-tested only. See finding 3. |
| Delete note | PT-0754F5395E, PT-EF24B1568D | Asserts Cancel, Delete, the editor reset and removal from the group. |
| Delete group keeps notes | — | **Not proved.** PT-0754F5395E deletes a group that is already empty. Store-level group deletion is covered by TASK-497's PT-F6E2585D72. |
| Shared selection/editor with the shelf | PT-2DFB759892 | The shelf card shows the body of the note opened from the sidebar. |
| Autosave with visible errors and retry | PT-8932C374BF (sidebar: none) | Shelf error/retry is TASK-498's PT-B4FF318316. **No sidebar e2e** for the error banner or retry. |
| Preserve text across navigation | — | **Not tested** in the sidebar. |
| Preserve text across project switching | — | **Not tested.** |
| Preserve text across restart | PT-8932C374BF | Simulated by calling `restoreUnsavedDraft()` again. No test relaunches the app with unsaved text. |
| Scheduled runs excluded | n/a | Nothing in the diff touches scheduling. |

## Findings: stale, uncovered and ambiguous contracts

1. **Both new e2e tests fail deterministically at the frozen snapshot (test defect).** `sidebarNotes.spec.ts:57` and `:91` call `getByRole('button', { name: 'Create' })` without `exact: true`. The match is a substring, so it hits six buttons, including this change's own "Create new note" header. Playwright's strict mode then throws before any grouping assertion runs. The fix is `{ name: 'Create', exact: true }`, which belongs to Implement, not this stage. Until that fix lands, the two contracts describe tests that do not get past their setup.
2. **The two e2e tests were not run by Implement, or did not pass there.** The defect above fails the test on every run, so neither test can have gone green at this snapshot.
3. **The `listitem` count assertion is ambiguous and probably wrong (PLAUSIBLE).** `sidebarNotes.spec.ts:61` expects exactly one notes-tree list item with the text "Beta". Group rows are `<li>` elements that contain their member `<li>`s, so the expanded Ideas group's `<li>` also contains "Beta". The count would then be 2. Finding 1 stops the test earlier, so this could not be observed. The comment above it ("a note in two groups") does not match the steps, which never put a note in two groups.
4. **Weak assertion:** after "Remove from this group" (`:70`), the test checks only that a Beta button is visible. A Beta button was already visible inside the expanded group, so this passes whether or not the note left the group.
5. **Title overclaims:** PT-0754F5395E says "deleting a group keeps notes", but the group is empty when it is deleted. The contract states this.
6. **The renderer unit tests run in no aggregate script.** `npm test --workspace=@praxis/desktop-renderer` is not called by the root `test` or `test:full`. Governed QA therefore never runs the 9 notesSession/notesTree tests.
7. **Earlier unit tests are uncatalogued:** the three TASK-498 tests in `notesSession.test.ts` (lines 35, 51, 66) have no Praxis Test contract. They are out of this task's scope and left as found.
8. **Not in the smoke set:** neither `sidebarNotes.spec.ts` nor `sessionShelfNotes.spec.ts` is in `SMOKE_SPECS`, so only the full `test:desktop` runs them.
9. **Generator limits carried over:** node tests are not indexed; titles built from template literals with expressions are skipped; every entry is labelled `project: functional`. The validator checks identity and that the flow fields are filled, not whether the prose is true.

## Environment note: e2e results here are not valid evidence

This worktree has no `node_modules`. Node resolves packages upward from the main checkout, and `@praxis/core` resolves to `/Users/daveacres/dev/tools/praxis/packages/core`, a different source tree from this worktree's core. As a result, `npm run build:renderer` fails `tsc` (`Property 'notes' does not exist on type 'PraxisIpc'`). The Electron main process under e2e also loads the other tree's core. Per the stage's non-goals, no link or install was made. The workflow's install stage has to provide this worktree's own dependencies before QA.

## Verification

| Check performed in this stage | Result |
| --- | --- |
| `npm run test:praxis-contracts` at the frozen snapshot | **Failed:** 2 new tests missing from the catalog. |
| `npm run test:praxis-contracts -- --write` | Wrote 742 contracts (740 carried over). |
| `npm run test:praxis-contracts` after edits | **Passed:** 742 catalogued and linked, no warnings. |
| ID audit of `task-499-notes.md` | All 6 IDs recomputed with SHA1(file + newline + title); both e2e IDs taken from the generated index. |
| `npm test --workspace=@praxis/desktop-renderer` | 9 passed, 0 failed/skipped (6 of them are TASK-499's). |
| `npx playwright test e2e/sidebarNotes.spec.ts e2e/sessionShelfNotes.spec.ts --project=functional` (pre-built renderer from 10:41) | 1 passed, 5 failed, 2 skipped. Both sidebar failures are finding 1 (strict-mode violation). The 3 shelf failures (project picker shows "No matches"; title not focused) passed in the TASK-498 stage and are not explained by this diff. Given the cross-tree `@praxis/core` resolution above, they are unattributed, neither confirmed as a regression nor ruled out. |
| `npm run build:renderer` | Failed in `tsc`; see the environment note. No rebuild or copy-renderer was possible. |

No UI changed in this stage, so no visual verification was done and no screenshot was kept. No stage was advanced, the workflow was not edited, and no tracker was changed.
