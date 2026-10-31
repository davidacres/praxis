# test-contracts

Ticket: PRX-T113-496 — TASK-496: Define note and group contracts.
Frozen implementation: `f1ba0c422c925124315336b4cea73f2f4fdd5e60`.
Stage iteration: 2 of 3.

## Outcome

Catalog validation passes. Ticket acceptance coverage is **not established**:
no linked-note/group domain contracts or meaningful tests for TASK-496 were
identified in this frozen snapshot. This report records findings; it does not
approve or advance any workflow stage.

## Analysis and scope

Before edits, verified a clean checkout whose HEAD exactly equals the required
snapshot. Inspected the supplied change-diff and patch, commit metadata, existing
catalog/report, catalog generator and validator, root test registration,
Playwright project configuration, core/desktop source references and related
session-group and designer-note tests.

The repository separates shared contracts in core, Electron IPC/preload in
main, and renderer consumers. The catalog generator independently parses desktop
E2E spec files with Babel; its validator compares generated identities and
nonempty Given/When/Then fields. Runtime project discovery uses Playwright
configuration instead. Node suites and other surfaces are separately registered
in root package.json and do not flow through this catalog.

The implementation plan was: establish frozen provenance; inventory and validate
existing contracts; trace note/group references and acceptance coverage; preserve
valid catalog IDs and prose; replace the stale companion report; run final
validation and diff checks. Only this report requires modification. No product,
test, generator, workflow, or unrelated catalog changes are justified here.

## Exact inventory and fresh verification

| Evidence | Result |
| --- | --- |
| Deterministic generated inventory | **749 Playwright source contracts across 167 spec files** |
| Duplicate generated IDs | **0** |
| Duplicate source-file/title pairs | **0** |
| Initial `npm run test:praxis-contracts` | Exit 0; 749 tests catalogued and linked; no moved-link warnings |
| Playwright `npx --no-install playwright test --list --reporter=json` from desktop-main | Exit 0; **959 project cases**, no discovery errors |
| Discovery project breakdown | functional 704; smoke 193; themes 50; theme-regressions 1; live-agent 11 |

Discovery counts project cases, including overlapping smoke/functional coverage;
it is not a unique-test count or a passing execution count. No runtime test suite
was executed. The exact static inventory is 749, not a complete monorepo runtime
count. Core/desktop Node suites, protocol/relay, Flutter and script checks are
outside this generator's scope.

Coverage links: [structured English catalog](catalog.json),
[complete automation index with exact file/line/title and IDs](index.md),
[generator/validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs),
[project routing](../../apps/praxis-desktop/main/playwright.config.ts),
[suite registration](../../package.json).
Every existing catalog ID and flow is preserved; regeneration was unnecessary.

## TASK-496 acceptance coverage

These are uncovered requirements, not invented automated contracts. No exact
automation link was identified for any row.

| Required Given / When / Then behavior | Coverage finding |
| --- | --- |
| Given notes and groups, when created or updated, then stable IDs, project ownership and timestamps follow the domain contract. | Not established |
| Given a note linked to multiple groups, when memberships are changed, then order and many-to-many identity/content are preserved. | Not established |
| Given a note/group request, when snapshotted, then content and membership semantics are explicit and stable. | Not established |
| Given invalid titles/bodies, missing IDs or cross-project requests, when submitted, then deterministic validation and IPC errors result. | Not established |
| Given malformed persisted data, when loaded, then the documented rejection/recovery contract is enforced. | Not established |
| Given a legacy schema without notes, when initialized, then compatibility is preserved with an empty notes collection. | Not established |

Keyword matches concern other domains: session grouping, board hierarchy,
designer canvas notes, AI brief user notes, feedback and scheduler tickets.
They must not be presented as evidence for private linked notes.

Two exact related links clarify the ambiguity:

- **PT-71A99A13A6**, Playwright, functional,
  [sessionGroups.spec.ts:19](../../apps/praxis-desktop/main/e2e/sessionGroups.spec.ts#L19),
  “chat and project session groups reorder, rename inline, and persist”.
  Given seeded chat/general/ticket sessions, when sessions and groups are dragged,
  renamed, collapsed and reopened, then session ordering/group membership and
  restart behavior are asserted. These are session groups, not note groups.
- **PT-2CB761CD9E**, Playwright, functional,
  [taskDesigner.spec.ts:190](../../apps/praxis-desktop/main/e2e/taskDesigner.spec.ts#L190),
  “note resize adorner sits on the item corner and resizes the outer node”.
  Given a designer canvas note, when its corner is dragged, then its adorner
  extends outside the frame and the node grows by asserted dimensions. This
  proves canvas geometry, not persistent linked-note contracts.

## Stale and ambiguous contracts

1. **Input provenance mismatch:** `.praxis/change-diff.md` targets PRX-S47-148,
   commit `4d41f0d5` against `d1e624fb`; its patch adds scheduled-run handover
   coverage. It does not describe TASK-496. Frozen HEAD instead has the title
   “Praxis Test contracts (workflow stage)” and changes only this report. Its
   parent is `5e6b8c89` (“Repair session browser and analysis flows after UI
   redesign”). The recovery patch also concerns unrelated Easy Mode automation
   row selectors. No substitute
   task patch was fabricated. Scheduled runs remain excluded from this audit's
   acceptance claims.
2. **Stale report replaced:** the inherited report targets parent `5e6b8c89`, not the
   requested `f1ba0c42`. This iteration refreshes provenance and verification;
   its 749-entry inventory remains accurate.
3. **Incomplete inventory scope:** the generator inventories direct literal-title
   `test(...)` calls only; dynamic titles and non-direct forms are omitted.
   All generated project fields say `functional`, including other project types.
   Use discovery/configuration for routing, not that field.
4. **Ambiguous English:** 744 of 749 entries retain the generic generated Then
   (“the automated assertions for this test pass and record the described
   user-visible result”). Shape validation does not prove behavioral precision.
   Unrelated flows were not broadly rewritten in this ticket stage.
5. **ID stability limitation:** IDs hash file path plus title. Line moves retain
   identity; file moves/title changes generate new IDs. None were changed here.
6. **Validator limits:** it does not verify prose truth, runtime success, complete
   suite enumeration, Markdown freshness, or all schema fields. Independent
   duplicate checks above found no duplicates; validation alone is not QA success.

## Returned QA smoke failures: individual disposition

The supplied QA excerpt reports npm exit 1 and test locations, but contains no
assertion error, launch failure, trace, or complete result counts. No root cause
can be assigned from those lines. Every row below remains **unresolved at
runtime**: this catalog-only stage does not change implementation or rerun QA.
Fresh validator/discovery success establishes links and registration, not repair.
All ten identifiable cases remain in both functional and smoke discovery.
The final supplied title was truncated; its file/line resolves to the full title
below. No additional unseen failures are inferred from the truncated excerpt.

| Returned case / stable contract | Exact automation | Assertions inspected / disposition |
| --- | --- | --- |
| Closing the issue detail panel — PT-A6199352B5 | [app.spec.ts:198](../../apps/praxis-desktop/main/e2e/app.spec.ts#L198) | Opens a card, clicks Close, asserts Close disappears. Link current; no runtime repair established. |
| Connections absent from sidebar, opens through palette — PT-B7E9ACDDB7 | [app.spec.ts:206](../../apps/praxis-desktop/main/e2e/app.spec.ts#L206) | Asserts absent sidebar control, Connections page and empty-state controls. Link current; no runtime repair established. |
| Background completion after turn — PT-CC54F83A0D | [backgroundTasks.spec.ts:26](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L26) | Asserts running then completed state, result, one completion notification and reload persistence. Link current; no runtime repair established. |
| Background failure — PT-B61A27A5EB | [backgroundTasks.spec.ts:69](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L69) | Asserts failed background state, badge and notification after foreground completion. Link current; no runtime repair established. |
| Lost background connection — PT-0D80392F88 | [backgroundTasks.spec.ts:71](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L71) | Asserts unknown state, badge and notification. Link current; no runtime repair established. |
| Native subagent completion — PT-FE74B5E007 | [backgroundTasks.spec.ts:73](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L73) | Shared helper asserts terminal background state, label and notification. Title's spawn distinction is broader than an explicit intermediate spawn assertion. No runtime repair established. |
| AIR child result — PT-A1760EEA2F | [backgroundTasks.spec.ts:75](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L75) | Asserts child result in background panel and absent from parent message events, plus completion notification. Link current; no runtime repair established. |
| Direct API shell exit — PT-A9058D99D0 | [backgroundTasks.spec.ts:78](../../apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts#L78) | Asserts exited/result-unavailable state and one exit notification without success notification; skips Windows. No runtime repair established. |
| Busy-status load more — PT-A9888638A2 | [boardFilters.spec.ts:32](../../apps/praxis-desktop/main/e2e/boardFilters.spec.ts#L32) | Adds five tickets; asserts lane 10→11, total 37→38, and disappearance of load-more. Title says next ten, but fixture exercises one remaining card. No runtime repair established. |
| Dropping a ticket into another lane still applies its workflow transition — PT-41ED9F62A9 | [boardFilters.spec.ts:65](../../apps/praxis-desktop/main/e2e/boardFilters.spec.ts#L65) | Dispatches HTML drag events; asserts APP-101 moves To Do→In Progress. This proves event-handler behavior, not physical pointer drag. No runtime repair established. |

No runtime or workflow changes were made to address these failures because they
are outside the authorized test-contracts stage. Their exact automation links
and assertion limits are now recorded for the responsible implementation/QA
stage, without advancing it.

## Final checks

Final `npm run test:praxis-contracts`: exit 0, 749 tests catalogued and linked,
no warnings. Final `git diff --check`: exit 0 with no whitespace errors. Only this report is modified.

## Handoff

The required report `test-contracts` is this file. The catalog is current but
TASK-496 coverage and the task-specific implementation diff remain missing from
the supplied frozen evidence. No UI change, visual verification or screenshot
capture was performed. No tracker mutation or other lifecycle action was taken.
