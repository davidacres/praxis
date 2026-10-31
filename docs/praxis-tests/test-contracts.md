# test-contracts

Ticket: PRX-T113-496 — TASK-496: Define note and group contracts.
Frozen implementation: `880dc9a6ebef73cf4a96a73148d8fe1b352ce72b`.

## Outcome

The deterministic validator passes: **732 Playwright contracts across 161 spec files**. The implementation adds **9 node:test tests across 2 files**, all passing in this stage. Nine structured English supplemental contracts now link those tests exactly. The documented union is **741 contracts**, not a complete monorepo test count: the generator excludes Node and other runners, and omits some Playwright forms.

Coverage links: [generated catalog](catalog.json), [automation index](index.md), [nine TASK-496 Given/When/Then contracts](task-496-notes.md), [generator/validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs), [core test registration](../../packages/core/package.json), [implementation evidence](../../.praxis/change-diff.md).

## Analysis and plan completed before edits

The clean live checkout HEAD is `20ea4c9ab5a91e50d9483cb26bfe4a04bf8656f2`, not the required snapshot. Its differences from the snapshot are limited to this report and the supplemental contract document. Exported `880dc9a6ebef73cf4a96a73148d8fe1b352ce72b` with `git archive` into `/private/tmp/WF-C1A4F13F-test-contracts-lxq0ewnl` and performed validation, compilation and focused execution there. Read the frozen change-diff, all note types, validators, snapshot helpers and test bodies; traced exports, NotesIpc declarations, core suite registration and main/renderer references. Shared pure contracts live in core; main is expected to supply project registry, IDs and clock later. NotesIpc is a future interface, with no preload exposure or operational consumer. The generator uses Babel to index direct literal-title E2E test calls and preserves curated flows by file/title-derived ID.

The ordered plan was to preserve the current generated inventory, correct the supplemental Node contracts and refresh the inherited report, then validate catalog identity, links and focused execution. The live checkout already contains the corrected supplemental snapshot reference; this run changes only this report. Product code, tests, generator, workflow and existing generated IDs remain unchanged.

## Requirement coverage

| Requirement | Exact contract evidence | Limits |
| --- | --- | --- |
| Stable identities, ownership, timestamps, malformed storage | PT-18D794703A, PT-D46A865FCF | Preserves supplied IDs; does not generate IDs or exercise writes. |
| Ordered many-to-many membership | PT-18D794703A, PT-D46A865FCF, PT-A5DB078E2D | Shared ordered links and validation; no persistence lifecycle. |
| Detached request snapshots | PT-212D8FD0B1, PT-2B8CC00CB1 | Order/provenance and later source mutation/deletion; no session submission. |
| Titles, bodies, immutable and empty patches | PT-8E6A92402A, PT-75D8223A74 | Tested boundary cases and sanitized failures. |
| Missing IDs, cross-project requests, IPC errors | PT-A5DB078E2D, PT-2B8CC00CB1, PT-2736E32C0B | Pure typed failures and an IPC-typed function; no real IPC transport. |
| Backward-compatible empty initialization | PT-780F67F095 | Undefined storage returns empty version 1; no migration of an actual application settings file. |

Each ID above resolves to runner, exact title, file and line in the [supplement](task-496-notes.md).

## Findings: stale and ambiguous evidence

1. The inherited report and supplement referenced snapshot 16da886d. The live checkout already corrects both to the required frozen snapshot 880dc9a6; independently verified all nine IDs, titles and exact source lines. Their existing empty-patch prose already matches the assertions. No generated Playwright identity or line drift was reported.
2. The generated inventory remains incomplete for the complete automated suite: Node tests and other runners are excluded; dynamic titles/non-direct test calls may be omitted; every generated project says functional regardless of runtime routing. No generator expansion is made in this ticket stage.
3. 724 of 732 generated entries retain generic Then prose. Validator success checks identity and populated flow fields, not assertion adequacy or prose truth. No unrelated contracts were rewritten.
4. Test title “initializes independently” has only one undefined-storage parse: independent repeated initialization is not explicitly asserted. The round-trip test parses JSON before mutation, so its non-aliasing check does not isolate direct-input copying. The Unicode boundary rejection also supplies body null, so that assertion alone does not isolate the astral-title limit. Supplemental prose records only what the assertions establish.
5. Persistence failure/rollback, atomic deletion cleanup, change notifications, actual IPC dispatch, ID generation and application-level migration are declared future integration responsibilities, not proved here. Scheduled runs remain excluded. No end-to-end note UI coverage is claimed.
6. IDs are derived from file and title: line moves preserve identity; file/title moves change IDs. The validator does not enforce all schema properties, duplicate detection or Markdown freshness, so independent duplicate/link checks were performed.

## Disposition of supplied review findings

- **Empty update patches — addressed in the frozen implementation.** The shared editable-input guard rejects `{}`. PT-75D8223A74 explicitly invokes both update validators and asserts VALIDATION_ERROR and the exact sanitized root issue. The same test retains title-only updates; PT-8E6A92402A retains body-only updates and explicit empty-body clearing. Both pass in this stage. The existing supplement describes this behavior accurately.
- **Missing persistence and operational IPC — addressed through the requested contracts-only acceptance alternative.** The frozen revision adds an explicit Contracts-only acceptance section to [TASK-496](../../apps/praxis-desktop/docs/plans/features/fx-bf-113-shelf-and-sidebar-notes/stories/fx-be-189/tasks/task-496.md), rather than relying only on the change-diff narrative. [TASK-497](../../apps/praxis-desktop/docs/plans/features/fx-bf-113-shelf-and-sidebar-notes/stories/fx-be-189/tasks/task-497.md) explicitly owns persistence, main/preload wiring, atomic saves, notifications and restoration. The checked-in acceptance now explicitly limits initialization to pure parsing and IPC evidence to typed JSON-compatible results; PERSISTENCE_FAILURE is a future handler obligation. Operational integration remains deferred and unverified, rather than fixed by this revision. This confirms the repository acceptance boundary, not a tracker update. No running handler or disk-failure guarantee is claimed; no ticket, implementation or workflow was changed in this stage.

## Verification

| Check performed in this stage | Result |
| --- | --- |
| npm run test:praxis-contracts | Passed, exit 0: 732 catalogued and linked; no line warnings. |
| Independent catalog inventory | 732 entries, 161 files, zero duplicate IDs or file/title pairs; all nine supplemental IDs, titles and source lines match. The deterministic validator reports no generated source-line drift. |
| npm run build:core | Passed, exit 0. |
| node --test packages/core/out/notes/noteValidation.test.js packages/core/out/notes/noteSnapshot.test.js | Passed, exit 0: 9 tests, 9 passed, 0 failed/skipped. |

Initial commands in the temporary export failed because its dependency link pointed at an absent worktree node_modules directory (`@babel/parser` and Node type definitions were missing). Correcting that temporary link to the existing `/Users/daveacres/dev/tools/praxis/node_modules` resolved both failures; the validator and core build then passed. No dependencies were installed or repository dependencies changed.

The implementation report's full-core and renderer results are prior-stage evidence, not reruns here. Full monorepo suites and Playwright runtime discovery/execution were not run in this catalog stage. No UI changes or visual verification occurred; no screenshot was captured. The required report **test-contracts** is this file. No stage advancement, workflow edit or tracker mutation was performed.
