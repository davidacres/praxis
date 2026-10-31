# test-contracts

Ticket: PRX-T113-496 — TASK-496: Define note and group contracts.
Frozen implementation: `5e6b8c89d9a01c49a4dae6d0552e2b1fd5f770cc`.

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
   “Repair session browser and analysis flows after UI redesign”. No substitute
   task patch was fabricated. Scheduled runs remain excluded from this audit's
   acceptance claims.
2. **Stale report replaced:** the inherited report described frozen commit
   `a8d574e71021b427576e4461882280d6ce199039`, 713 catalog entries and scheduling
   acceptance. Those figures are not evidence for this ticket/snapshot.
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

## Final checks

Final `npm run test:praxis-contracts`: exit 0, 749 tests catalogued and linked,
no warnings. Final `git diff --check`: exit 0 after removing trailing whitespace
found in the first report-only diff check. Only this report is modified.

## Handoff

The required report `test-contracts` is this file. The catalog is current but
TASK-496 coverage and the task-specific implementation diff remain missing from
the supplied frozen evidence. No UI change, visual verification or screenshot
capture was performed. No tracker mutation or other lifecycle action was taken.
