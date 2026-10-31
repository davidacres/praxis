# test-contracts

Ticket: PRX-T113-496 — TASK-496: Define note and group contracts.
Frozen implementation: `e6d04ce72afb38bfe83114499a4a6a6450bae0e3`.

## Outcome

The deterministic validator passes: **732 Playwright contracts across 161 spec files**. The implementation adds **9 node:test tests across 2 files**, all passing in this stage. Nine structured English supplemental contracts now link those tests exactly. The documented union is **741 contracts**, not a complete monorepo test count: the generator excludes Node and other runners, and omits some Playwright forms.

Coverage links: [generated catalog](catalog.json), [automation index](index.md), [nine TASK-496 Given/When/Then contracts](task-496-notes.md), [generator/validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs), [core test registration](../../packages/core/package.json), [implementation evidence](../../.praxis/change-diff.md).

## Analysis and plan completed before edits

Verified the clean checkout HEAD equals the required frozen implementation SHA. Read the frozen change-diff, all note types, validators, snapshot helpers and test bodies; traced exports, NotesIpc declarations, core suite registration and main/renderer references. Shared pure contracts live in core; main is expected to supply project registry, IDs and clock later. NotesIpc is a future interface, with no preload exposure or operational consumer. The generator uses Babel to index direct literal-title E2E test calls and preserves curated flows by file/title-derived ID.

The ordered plan was to preserve the current generated inventory, author focused supplemental Node contracts, replace the stale inherited report, then validate catalog identity, links and focused execution. Only this report and task-496-notes.md are changed. Product code, tests, generator, workflow and existing generated IDs remain unchanged.

## Requirement coverage

| Requirement | Exact contract evidence | Limits |
| --- | --- | --- |
| Stable identities, ownership, timestamps, malformed storage | PT-18D794703A, PT-D46A865FCF | Preserves supplied IDs; does not generate IDs or exercise writes. |
| Ordered many-to-many membership | PT-18D794703A, PT-D46A865FCF, PT-A5DB078E2D | Shared ordered links and validation; no persistence lifecycle. |
| Detached request snapshots | PT-212D8FD0B1, PT-2B8CC00CB1 | Order/provenance and later source mutation/deletion; no session submission. |
| Titles, bodies, immutable patches | PT-8E6A92402A, PT-75D8223A74 | Tested boundary cases and sanitized failures. |
| Missing IDs, cross-project requests, IPC errors | PT-A5DB078E2D, PT-2B8CC00CB1, PT-2736E32C0B | Pure typed failures and an IPC-typed function; no real IPC transport. |
| Backward-compatible empty initialization | PT-780F67F095 | Undefined storage returns empty version 1; no migration of an actual application settings file. |

Each ID above resolves to runner, exact title, file and line in the [supplement](task-496-notes.md).

## Findings: stale and ambiguous evidence

1. The inherited report referenced snapshot 56bab2a6 and claimed TASK-496 implementation was absent. That claim is stale: this frozen snapshot contains the implementation and nine tests. Replaced the report; unrelated historical QA failure excerpts are not current-stage results.
2. The generated inventory remains incomplete for the complete automated suite: Node tests and other runners are excluded; dynamic titles/non-direct test calls may be omitted; every generated project says functional regardless of runtime routing. No generator expansion is made in this ticket stage.
3. 724 of 732 generated entries retain generic Then prose. Validator success checks identity and populated flow fields, not assertion adequacy or prose truth. No unrelated contracts were rewritten.
4. Test title “initializes independently” has only one undefined-storage parse: independent repeated initialization is not explicitly asserted. The round-trip test parses JSON before mutation, so its non-aliasing check does not isolate direct-input copying. The Unicode boundary rejection also supplies body null, so that assertion alone does not isolate the astral-title limit. Supplemental prose records only what the assertions establish.
5. Persistence failure/rollback, atomic deletion cleanup, change notifications, actual IPC dispatch, ID generation and application-level migration are declared future integration responsibilities, not proved here. Scheduled runs remain excluded. No end-to-end note UI coverage is claimed.
6. IDs are derived from file and title: line moves preserve identity; file/title moves change IDs. The validator does not enforce all schema properties, duplicate detection or Markdown freshness, so independent duplicate/link checks were performed.

## Verification

| Check performed in this stage | Result |
| --- | --- |
| npm run test:praxis-contracts | Passed, exit 0: 732 catalogued and linked; no line warnings. |
| Independent catalog inventory | 732 entries, 161 files, zero duplicate IDs or file/title pairs. |
| npm run build:core | Passed, exit 0. |
| node --test packages/core/out/notes/noteValidation.test.js packages/core/out/notes/noteSnapshot.test.js | Passed, exit 0: 9 tests, 9 passed, 0 failed/skipped. |

The implementation report's full-core and renderer results are prior-stage evidence, not reruns here. Full monorepo suites and Playwright runtime discovery/execution were not run in this catalog stage. No UI changes or visual verification occurred; no screenshot was captured. The required report **test-contracts** is this file. No stage advancement, workflow edit or tracker mutation was performed.
