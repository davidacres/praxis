# test-contracts

Ticket: PRX-T113-496 — TASK-496: Define note and group contracts.
Frozen snapshot: `56bab2a61ecc064858d7ceca5610941cae465543`.
Stage iteration: 5 of 5.

## Outcome

The deterministic validator passes: **732 Playwright source contracts across
161 spec files**, with zero duplicate IDs or file/title pairs. TASK-496 acceptance
coverage is **not established**. No linked-note/group domain implementation or
meaningful tests for its acceptance requirements were identified in the supplied
snapshot. This report records findings and does not approve or advance a stage.

## Analysis and ordered plan

Before editing, verified a clean checkout at the exact frozen SHA. Read the
existing catalog, report, generator/validator, test registration, Playwright
configuration, supplied change-diff and patch path inventories. Searched core,
Electron main/preload and renderer for linked-note/group types and consumers;
inspected the returned QA test bodies and shared background-outcome helper.
Core owns shared contracts, main exposes IPC through preload, and renderer
consumes that bridge. The catalog independently parses E2E source with Babel;
Node suites are separately registered and are outside this generator.

The ordered plan was to verify frozen provenance, inventory existing contracts,
trace requirement coverage and returned QA cases, update only demonstrably
ambiguous prose and the stale report, then run deterministic validation and
whitespace checks. Changes are confined to `catalog.json` (three flow fields)
and this report. No automated source, product code, generator, workflow or
unrelated workspace files are changed. The index remains current because all
IDs, titles, source locations and project fields are preserved.

## Exact inventory and verification

| Evidence | Result |
| --- | --- |
| Frozen generated inventory | 732 entries across 161 E2E spec files |
| Duplicate IDs / file-title links | 0 / 0 |
| Initial `npm run test:praxis-contracts` | Exit 0; 732 catalogued and linked; no warnings |
| `npx --no-install playwright test --list --reporter=json` in desktop-main | Exit 0; 938 project cases; no discovery errors |
| Discovery by project | functional 691; smoke 189; themes 46; theme-regressions 1; live-agent 11 |

Project cases include overlapping smoke/functional runs. They are neither unique
tests nor passed executions. No runtime suite was run in this documentation-only
stage. The exact generated count is 732; a complete monorepo runtime count is
not established by this catalog. Core/main Node tests, protocol/relay, Flutter
and script checks are outside its scope.

Coverage links: [structured English catalog](catalog.json),
[exact ID, title and automation index](index.md),
[generator and validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs),
[Playwright project routing](../../apps/praxis-desktop/main/playwright.config.ts),
[root suite registration](../../package.json),
[core suite registration](../../packages/core/package.json).
Each catalog entry supplies runner, file, line and exact title. The generated
project field has the limitations below; use Playwright configuration for routing.

## TASK-496 acceptance coverage

No exact automation link was identified for these required journeys. They are
coverage findings, not new contracts claiming unimplemented behavior.

| Required Given / When / Then behavior | Finding |
| --- | --- |
| Given notes and groups, when created or updated, then stable IDs, project ownership and timestamps satisfy the domain contract. | Not established |
| Given notes linked to multiple groups, when membership changes, then ordered many-to-many relationships preserve identity and content. | Not established |
| Given a note/group request, when snapshotted, then content and membership semantics are explicit and stable. | Not established |
| Given invalid titles/bodies, missing IDs or cross-project requests, when submitted, then deterministic validation and IPC errors result. | Not established |
| Given malformed persisted data, when loaded, then the specified rejection/recovery contract is enforced. | Not established |
| Given legacy data without notes, when initialized, then compatibility is preserved with an empty notes collection. | Not established |

The designer-note test **PT-2CB761CD9E**, Playwright functional,
[taskDesigner.spec.ts:191](../../apps/praxis-desktop/main/e2e/taskDesigner.spec.ts#L191),
starts with a seeded canvas note, drags its corner and asserts outer-frame
adorner positioning and growth. This proves canvas geometry, not persistent
linked-note ownership or membership. The inherited report's session-group
contract PT-71A99A13A6 is absent from this snapshot's catalog and source-file
inventory; its asserted coverage has been removed.

## Catalog updates and stale or ambiguous contracts

1. **Provenance mismatch:** the supplied tracked `.praxis/change-diff.md` targets
   PRX-S47-148 at `4d41f0d5` against `d1e624fb`. Its patch concerns scheduled-run
   handover; its recovery patch changes an Easy Mode hover test. Neither is a
   TASK-496 implementation patch. The required frozen SHA changes only this
   report and has parent `42d2dcc6`, another test-contracts stage commit. No
   substitute implementation patch was fabricated; scheduled runs remain excluded.
2. **Stale report corrected:** the inherited report names snapshot `e3765c3e`,
   iteration 4, 749 entries/167 files and 959 discovery cases. Fresh verification
   establishes the counts above. Returned QA source locations also differ from
   this snapshot; exact current links are recorded below.
3. **Three English contracts clarified:** PT-FE74B5E007 now describes only terminal
   background state and notification assertions, without claiming an explicit
   spawn-versus-completion timing assertion. PT-A1760EEA2F describes completion,
   absence of child result text in parent message events and one notification;
   it does not claim a positive child-result assertion. PT-A9888638A2 describes
   the actual 10-to-11 Backlog and 37-to-38 total counts; the title's next-ten
   claim is broader than the fixture. All generated identities remain stable.
4. **Inventory limitations:** only direct literal-title `test(...)` calls are
   collected. Dynamic titles and non-direct forms are omitted. Every generated
   project says functional regardless of runtime routing. This is an incomplete
   index of the complete automated suite; no generator expansion is attempted.
5. **Remaining generic prose:** 724 of 732 entries retain the generated generic
   Then. Validator shape checks cannot establish behavioral precision. Unrelated
   flows were not broadly rewritten in this ticket stage.
6. **Identity and validator limits:** IDs hash file path plus title; moving lines
   preserves IDs, while file/title changes generate new ones. The validator does
   not prove prose truth, runtime success, full-suite enumeration, Markdown
   freshness or all schema fields. Duplicate checks were performed independently.

## Returned QA failures: individual disposition

All ten identifiable failures remain **unresolved at runtime**. The excerpt
provides npm exit 1 and test names/locations, without assertion errors, traces,
launch diagnostics or complete counts. A root cause cannot be assigned from
that evidence. This stage updates contracts and reports coverage; no runtime
repair or QA rerun is claimed. All ten are registered in both functional and
smoke discovery. The truncated final title resolves by source and title prefix.

| Stable ID and exact title | Frozen automation (Playwright) | Disposition |
| --- | --- | --- |
| PT-A6199352B5 — closing the issue detail panel hides it | [app.spec.ts:176](../../apps/praxis-desktop/main/e2e/app.spec.ts#L176) | QA line 198 is now 176. Opens a card, clicks Close, asserts it disappears. No repair established. |
| PT-B7E9ACDDB7 — Connections is absent from the sidebar and opens through the command palette | [app.spec.ts:184](../../apps/praxis-desktop/main/e2e/app.spec.ts#L184) | QA line 206 is now 184. Asserts sidebar absence and Connections page/empty-state controls. No repair established. |
| PT-CC54F83A0D — background completion arrives after the turn, updates the session, and notifies once | [backgroundTasks.spec.ts:26](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L26) | Line 26 remains current. Asserts running then completed background state, one notification and reload persistence. No explicit positive result-content assertion. No repair established. |
| PT-B61A27A5EB — background failure is reported after the foreground reply | [backgroundTasks.spec.ts:62](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L62) | QA line 69 is now 62. Asserts failed task state, badge and notification after foreground completion. No repair established. |
| PT-0D80392F88 — a lost background connection becomes unknown rather than completed | [backgroundTasks.spec.ts:64](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L64) | QA line 71 is now 64. Asserts unknown task state, badge and notification. No repair established. |
| PT-FE74B5E007 — native subagent completion is distinct from successful spawn | [backgroundTasks.spec.ts:66](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L66) | QA line 73 is now 66. Contract narrowed to helper assertions; intermediate spawn state is not explicitly asserted. Runtime failure remains unresolved. |
| PT-A1760EEA2F — AIR child completion and its result reach the owning session separately from the parent transcript | [backgroundTasks.spec.ts:68](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L68) | QA line 75 is now 68. Contract narrowed: child-result absence from parent messages is asserted; positive result delivery is not. Runtime failure remains unresolved. |
| PT-A9058D99D0 — a direct API agent shell process reports its exit after the AI reply without inventing success | [backgroundTasks.spec.ts:71](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L71) | QA line 78 is now 71. Asserts exited task state, one exit notice and absence of success notice; skips Windows. No explicit numeric exit-code assertion. No repair established. |
| PT-A9888638A2 — load-more fetches the next ten for a busy status without starving the other lanes | [boardFilters.spec.ts:33](../../apps/praxis-desktop/main/e2e/boardFilters.spec.ts#L33) | QA line 32 is now 33. Contract corrected to actual paging counts; a full next-ten page remains unproven. Runtime failure remains unresolved. |
| PT-41ED9F62A9 — dropping a ticket into another lane still applies its workflow transition | [boardFilters.spec.ts:66](../../apps/praxis-desktop/main/e2e/boardFilters.spec.ts#L66) | QA line 65 is now 66. Dispatches HTML drag events and asserts APP-101 moves To Do to In Progress. Physical pointer drag is not proven. No repair established. |

Iterations 1–4 each reported npm exit 1 without sufficient failure diagnostics.
None is established as repaired by catalog validation. The current iteration-5
excerpt identifies the ten cases above, all individually accounted for. Unrelated
runtime fixes are outside this stage; no unseen failures are inferred.

## Final checks and handoff

Final `npm run test:praxis-contracts`: exit 0; 732 catalogued and linked, no
warnings. Final `git diff --check`: exit 0. Only this report and three curated
catalog flows changed. No UI change or visual verification was performed and
no screenshot was captured.

The required report **test-contracts** is this file. The catalog validates, but
TASK-496 implementation evidence and acceptance coverage remain missing. No
tracker mutation, workflow edit, stage advancement or lifecycle action was taken.
