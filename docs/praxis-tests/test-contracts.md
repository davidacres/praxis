# test-contracts

Ticket: PRX-T113-501 — TASK-501: Handle send failures and note snapshot history.
Frozen implementation: `fb0747003babcaaa88b8ad0e238624f1b0dad6a5`. It was the checkout HEAD when this stage ran, with a clean tree, so no export was needed.

## Outcome

At the frozen snapshot the validator failed with **5 problems**: the five tests TASK-501 added to `noteSessionHandoff.spec.ts` were missing from the catalog. After `--write` and curated prose for all five, it passes: **752 Playwright contracts catalogued and linked** (747 carried over), with no line-drift warnings.

The task contributes **5 Playwright tests** and **2 node:test tests**, so this task documents **7 new contracts**. One existing contract (PT-35D3A2F43C) was rewritten because TASK-501 changed how its test clicks Send. That is not a full monorepo count, because the generator indexes only Playwright.

Coverage links: [generated catalog](catalog.json), [automation index](index.md), [2 TASK-501 node:test contracts](task-501-notes.md), [generator/validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs), [e2e spec](../../apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts), unit tests [noteSendReference](../../apps/praxis-desktop/renderer/test/noteSendReference.test.ts) and [noteSendStore](../../apps/praxis-desktop/renderer/test/noteSendStore.test.ts).

| ID | Runner | Automation | Test |
| --- | --- | --- | --- |
| PT-6C43ED01A2 | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:137` | a rejected send keeps the note, chip and instruction, and retry sends the same snapshot |
| PT-7C9174A432 | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:161` | editing or deleting a note after sending changes nothing already recorded |
| PT-F56F3DC1A3 | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:179` | a note deleted before the dialog opens is left out of the preview |
| PT-91DB826501 | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:194` | a destination that disappears is reported, not replaced by a new session |
| PT-3FA587C66D | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:213` | a failed new-session Start keeps the goal and the note chip |
| PT-FF8CD95C75 | node:test | `apps/praxis-desktop/renderer/test/noteSendReference.test.ts:47` | a reference records provenance as a copy, and only the raw message carries it |
| PT-3091915D5B | node:test | `apps/praxis-desktop/renderer/test/noteSendStore.test.ts:31` | the saved instruction survives staging and is cleared only when the handoff is taken |
| PT-35D3A2F43C (updated) | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:78` | a group previews in group order and sends once to an existing session |

## Changes in this stage

- `catalog.json` / `index.md`: regenerated with `--write`. Five entries added; the four TASK-500 entries moved down 4–5 lines. The placeholder Given/When/Then on the five new entries was replaced with prose that states only what each test asserts, and records where a title promises more than the test checks.
- PT-35D3A2F43C: the flow said the user "double-clicks Send". The test now fires two scripted `click()` calls in one frame, so the contract says that, and that it tests the submit guard rather than pointer timing.
- `task-501-notes.md`: new; 2 node:test contracts.
- `test-contracts.md`: this report (replaces the TASK-500 report; that one remains in git history).

No product code, test, generator or workflow definition was changed.

## Requirement coverage

| TASK-501 requirement | Contract evidence | Limits |
| --- | --- | --- |
| Record snapshot provenance and content in the session message | PT-FF8CD95C75, PT-6C43ED01A2 | Unit test checks the full provenance shape for a group. E2e checks only that the message contains the note id and an `updatedAt` field. Single-note provenance is not asserted. |
| No live coupling to the notes | PT-FF8CD95C75, PT-7C9174A432 | The unit test proves the reference is a copy. The e2e test proves edit/delete make no new provider call; see finding 2. |
| Later edits | PT-7C9174A432, PT-35D3A2F43C | |
| Deleted notes | PT-F56F3DC1A3 (before opening), PT-7C9174A432 (after sending) | Deletion while the dialog is open is not tested. |
| Empty groups | PT-63BC0F273F (TASK-500) | Unchanged by TASK-501. |
| Unavailable destinations | PT-91DB826501 | Simulated by broadcasting `ai:sessionDeleted`; recovering by choosing another destination is not tested. |
| Provider rejection | PT-6C43ED01A2 (existing session), PT-3FA587C66D (new session) | No error message asserted on the new-session path. |
| Rapid double-clicks | PT-35D3A2F43C | Existing-session Send only. Rapid clicks on "Continue in new session" and on Start are not tested. |
| Retry | PT-6C43ED01A2 | Existing session only. Retrying Start after a failed new session is not tested. |
| Preserve notes after failure | PT-6C43ED01A2 | Checks that "beta body" is still returned by the notes API. |
| Preserve unsent instructions after failure | PT-6C43ED01A2, PT-3FA587C66D, PT-91DB826501, PT-3091915D5B | |
| Reuse current submission safeguards | PT-6C43ED01A2, PT-35D3A2F43C | Retry uses the session's own follow-up Send. |
| No hidden AI calls on ordinary note actions | PT-7C9174A432, PT-F56F3DC1A3, PT-91DB826501 | Edit and delete through the API, open, cancel and lost destination all keep the provider count fixed. Note creation and grouping happen in `seed` before counting starts. |
| Scheduled runs excluded | n/a | Nothing in the diff touches scheduling. |

## Findings: stale, uncovered and ambiguous contracts

1. **The busy-session (queued) restore branch is untested.** `SessionsPage.tsx:970-971` now restores the draft text and context chips when a handoff reaches a session that is not completed. The seed session is always `completed`, so only the `continueSession` failure branch (`:993-994`) is exercised.
2. **"Changes nothing already recorded" is weaker than its title (ambiguous).** PT-7C9174A432 compares the mock's call log before and after edit/delete. That log is a string in main-process memory and cannot change after it is recorded. The test proves no new provider call is made. It does not check a rendered transcript, receipt or stored session history. The real "it's a copy" guarantee comes from the unit test PT-FF8CD95C75.
3. **"Double-click" is scripted, not a pointer double-click.** PT-35D3A2F43C now calls `click()` twice in one frame. This is a deliberate smoke-set rule (no real pointer) and is a stronger test of `confirmingRef`, but it is not what a user's double-click does. The catalog prose was corrected to say so.
4. **A lost destination is simulated.** PT-91DB826501 broadcasts `ai:sessionDeleted` from main; the mocked `ai:listSessions` still returns the session. The renderer's real deletion listener in `App.tsx` is exercised; the real delete path (`deleteAgentSession.ts`) is not. The "Unavailable session" option label is not asserted.
5. **The failed new-session Start shows no asserted error.** PT-3FA587C66D checks that the goal and chip survive and one delegate call was made. Whether the user is told it failed is not checked.
6. **Deleted-note preview checks a count only.** PT-F56F3DC1A3 does not check which note stayed, or the group's stored membership.
7. **Carried over from TASK-500, still open:** single-note handoff has no journey test (every e2e sends the "Ideas" group); focus trap, Escape and focus return are untested; the preview error path (`note-send-error`) is untested.
8. **The renderer unit tests still run in no aggregate script.** The root `test` and `test:full` do not call `npm test --workspace=@praxis/desktop-renderer`, so governed QA never runs these 2 tests or the 16 earlier ones. Reported for TASK-499 and TASK-500; unchanged.
9. **Generator limits carried over:** node tests are not indexed; titles built from template literals with expressions are skipped; every entry is labelled `project: functional`. The validator checks identity and that the flow fields are filled, not whether the prose is true.

On the positive side, `noteSessionHandoff` is still in `SMOKE_SPECS` (`playwright.config.ts:26`), so governed runs execute all nine of its tests, and the new tests use no hover, `page.mouse`, drag or screenshots.

## Environment note: no e2e run in this stage

This worktree has no `node_modules`; packages resolve from the parent checkout's `node_modules`. The pre-built renderer in `apps/praxis-desktop/main/renderer/` is from 14:55, before the frozen commit (14:59). An e2e run here could test a renderer without this change, so its result would not be evidence for this snapshot. Per the stage's non-goals, nothing was linked or installed. The workflow's install, build and QA stages provide the e2e run.

## Verification

| Check performed in this stage | Result |
| --- | --- |
| `npm run test:praxis-contracts` at the frozen snapshot | **Failed:** 5 new tests missing from the catalog. |
| `npm run test:praxis-contracts -- --write` | Wrote 752 contracts (747 carried over). |
| `npm run test:praxis-contracts` after edits | **Passed:** 752 catalogued and linked, no warnings. |
| ID audit of `task-501-notes.md` | Both IDs computed with SHA1(file + newline + title); the method reproduces TASK-500's PT-3E8EC78A44. Line numbers checked against the source. The 5 e2e IDs come from the generated catalog. |
| `npm test` in `apps/praxis-desktop/renderer` | 18 passed, 0 failed or skipped (2 of them are TASK-501's). |
| Playwright `noteSessionHandoff.spec.ts` | Not run; see the environment note. |

No UI changed in this stage, so no visual verification was done and no screenshot was kept. No stage was advanced, the workflow was not edited, and no tracker was changed.
