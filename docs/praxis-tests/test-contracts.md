# test-contracts

Ticket: PRX-T113-500 — TASK-500: Add note and group session handoff.
Frozen implementation: `59e34fccb5aafea06d948a569aaa8e55f21689ff` (it was the checkout HEAD when this stage ran, with a clean tree, so no export was needed).

## Outcome

At the frozen snapshot the validator failed with **4 problems**: the four tests in the new `noteSessionHandoff.spec.ts` were missing from the catalog. After `--write` and curated prose for all four, it passes: **746 Playwright contracts catalogued and linked** (742 carried over unchanged), with no line-drift warnings.

The task contributes **4 Playwright tests** and **7 node:test tests**, so this task documents **11 contracts**. That is not a full monorepo count, because the generator indexes only Playwright.

Coverage links: [generated catalog](catalog.json), [automation index](index.md), [7 TASK-500 node:test contracts](task-500-notes.md), [generator/validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs), [e2e spec](../../apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts), unit tests [noteSendReference](../../apps/praxis-desktop/renderer/test/noteSendReference.test.ts) and [noteSendStore](../../apps/praxis-desktop/renderer/test/noteSendStore.test.ts).

| ID | Runner | Automation |
| --- | --- | --- |
| PT-90ABEBFC94 | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:60` |
| PT-35D3A2F43C | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:74` |
| PT-26461FF4CC | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:99` |
| PT-63BC0F273F | playwright | `apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:120` |
| PT-3E8EC78A44 | node:test | `apps/praxis-desktop/renderer/test/noteSendReference.test.ts:11` |
| PT-DF4904DCB7 | node:test | `apps/praxis-desktop/renderer/test/noteSendReference.test.ts:22` |
| PT-BF2D16D5CC | node:test | `apps/praxis-desktop/renderer/test/noteSendReference.test.ts:29` |
| PT-5EBAB8CEEE | node:test | `apps/praxis-desktop/renderer/test/noteSendReference.test.ts:36` |
| PT-A46CCC1147 | node:test | `apps/praxis-desktop/renderer/test/noteSendStore.test.ts:7` |
| PT-07B180DC2A | node:test | `apps/praxis-desktop/renderer/test/noteSendStore.test.ts:15` |
| PT-D2E0BD9A9E | node:test | `apps/praxis-desktop/renderer/test/noteSendStore.test.ts:24` |

## Changes in this stage

- `catalog.json` / `index.md`: regenerated with `--write`, adding the 4 entries. The generic placeholder Given/When/Then was replaced with prose that states only what each test asserts, and records where a title promises more than the test checks.
- `task-500-notes.md`: new; 7 node:test contracts.
- `test-contracts.md`: this report (replaces the TASK-499 report; that one remains in git history at `64c02f5b`).

No product code, test, generator or workflow definition was changed.

## Requirement coverage

| TASK-500 requirement | Contract evidence | Limits |
| --- | --- | --- |
| Send to session for an ordered **group** | PT-35D3A2F43C, PT-26461FF4CC, PT-3E8EC78A44 | Opened from the sidebar group menu only. |
| Send to session for **one note** | PT-DF4904DCB7 (label only) | **No e2e coverage.** Neither the note row's "Send to session…" menu item nor the editor's `note-send-open` button is exercised. Every e2e test sends the "Ideas" group. |
| Choose an **existing** compatible session in the same project | PT-35D3A2F43C, PT-5EBAB8CEEE | The e2e seed has one session, so the destination is the default and is never picked from a list. Filtering (other project, archived, subagent, workflow, review) is unit-tested only. |
| Choose a **new** session | PT-90ABEBFC94, PT-26461FF4CC | |
| Preview snapshot titles, body and order | PT-35D3A2F43C, PT-90ABEBFC94 | The e2e test checks titles and order (`<strong>`) and the note count. Preview bodies are not asserted on screen; body order is asserted in the sent message. |
| Snapshot is fixed at send time | PT-3E8EC78A44, PT-35D3A2F43C | The unit test proves the content is copied. In e2e, see finding 3. |
| User can add instructions | PT-35D3A2F43C, PT-26461FF4CC, PT-DF4904DCB7 | The empty-instruction default is unit-tested only. |
| Explicit Send required | PT-35D3A2F43C, PT-26461FF4CC | Existing session: a double-click on Send produces exactly one `continueSession` call. New session: nothing is sent until Start. |
| Cancel makes no provider request | PT-90ABEBFC94 | Only the Cancel button. Escape, the Close button and an overlay click are untested. Draft instructions surviving Cancel are unit-tested only (PT-07B180DC2A). |
| Opening makes no provider request | PT-90ABEBFC94 | |
| Destination creation makes no provider request | PT-90ABEBFC94, PT-26461FF4CC | Asserted after switching to "New session…" and after landing in the New Session composer. |
| Extend context types | PT-3E8EC78A44, PT-DF4904DCB7 | `note-group` kind asserted; the single note's `note` kind is not. |
| Compact chat receipts | PT-BF2D16D5CC | Unit only. **No e2e** checks the receipt rendered in a session transcript. |
| Empty group cannot be sent | PT-63BC0F273F | |
| Handoff only auto-submits shortly after Send (fix in `59e34fcc`) | PT-D2E0BD9A9E | Predicate only. See finding 4. |
| Dialog focus trap and focus return (fix in `59e34fcc`) | — | **Not tested.** |
| Scheduled runs excluded | n/a | Nothing in the diff touches scheduling. |

## Findings: stale, uncovered and ambiguous contracts

1. **Single-note handoff has no journey test.** The ticket's first case is "one note". Both entry points added for it (note row menu, editor button) are unexercised. Only the label and default instruction are unit-tested.
2. **New-session test does not prove the instruction carries over to the goal (ambiguous).** `noteSessionHandoff.spec.ts:111` fills the goal box itself with the same text the instruction used ("Plan from these"). So the test passes whether or not `newSessionGoal` pre-fills it. The comment at `:110` says Start stays disabled without a goal, but nothing asserts that. The delegate payload is checked for "alpha body" only; "beta body" and the order are not checked on this path.
3. **"Later edits don't resend" is a weak check.** `:95–96` edits the note and reads the call count once, with no wait. It shows there was no immediate resend. It does not prove that none happens later, or that the delivered message is unchanged.
4. **Stale or busy handoff behaviour is untested in the UI.** `59e34fcc` changed `SessionsPage` so a handoff that is stale, or that reaches a busy session, only fills the composer and keeps existing draft text and chips. Only the `isFreshHandoff` predicate is tested. Merging with an existing draft, and the not-sending branch, have no test.
5. **Focus trap, Escape and focus return are untested.** All three were added in `59e34fcc`.
6. **Preview error path is untested.** Nothing exercises a failed `prepareSnapshot` (`note-send-error`), or checks that the confirm button stays disabled while the preview is loading.
7. **The renderer unit tests still run in no aggregate script.** The root `test` and `test:full` do not call `npm test --workspace=@praxis/desktop-renderer`, so governed QA never runs these 7 tests or the 9 earlier ones. This was already reported for TASK-499 and has not changed.
8. **Generator limits carried over:** node tests are not indexed; titles built from template literals with expressions are skipped; every entry is labelled `project: functional`. The validator checks identity and that the flow fields are filled, not whether the prose is true.

On the positive side, `noteSessionHandoff` was added to `SMOKE_SPECS`, so governed runs execute it. It uses no hover, `page.mouse`, drag or screenshots.

## Environment note: no e2e run in this stage

This worktree has no `node_modules`. `@praxis/core` resolves to `/Users/daveacres/dev/tools/praxis/packages/core/out`, the main checkout's tree, not this worktree's. The pre-built renderer in `apps/praxis-desktop/main/renderer/` dates from 11:08, before both TASK-500 commits (11:11 and 11:12). An e2e run here would therefore test a renderer without this change, and the wrong core. It was not run, because its result would not be evidence for this snapshot. Per the stage's non-goals, no link or install was made. The workflow's install and QA stages have to provide this.

## Verification

| Check performed in this stage | Result |
| --- | --- |
| `npm run test:praxis-contracts` at the frozen snapshot | **Failed:** 4 new tests missing from the catalog. |
| `npm run test:praxis-contracts -- --write` | Wrote 746 contracts (742 carried over). |
| `npm run test:praxis-contracts` after edits | **Passed:** 746 catalogued and linked, no warnings. |
| ID audit of `task-500-notes.md` | All 7 IDs recomputed with SHA1(file + newline + title); line numbers checked against the source. The 4 e2e IDs were taken from the generated catalog. |
| `npm test --workspace=@praxis/desktop-renderer` | 16 passed, 0 failed or skipped (7 of them are TASK-500's). |
| Playwright `noteSessionHandoff.spec.ts` | Not run; see the environment note. |

No UI changed in this stage, so no visual verification was done and no screenshot was kept. No stage was advanced, the workflow was not edited, and no tracker was changed.
