# test-contracts

Target: PRX-S47-148, frozen implementation `a8d574e71021b427576e4461882280d6ce199039`.
The checkout was clean and HEAD exactly matched the target before edits. Inspected
`.praxis/change-diff.md`, its referenced implementation history, generator,
existing catalog/report, scheduler tests, handover guard tests, root scripts and
Playwright configuration. The supplied change-diff describes implementation
`4d41f0d5` against `d1e624fb`; the frozen target includes later changes. Counts
below are freshly derived from the target, rather than copied from that report.

## Exact inventory and validation

- **713 generated Playwright source contracts in 158 spec files**; **26 scheduling contracts** (25 scheduler, one provider handover).
- **723 Playwright project executions discovered** (661 functional, 50 themes, one theme-regressions, 11 live-agent), exit 0, no discovery errors, using `npx playwright test --list --reporter=json` in desktop-main. Discovery is not execution or a passing-test count.
- Zero duplicate generated IDs; zero duplicate source-file/title pairs.
- Initial validator exited 0 but warned of five moved Easy Mode source links (PT-C7547B818D, PT-D6E1059F2C, PT-2516802E6F, PT-21C54F260E, PT-BD3466D9E5). Regeneration refreshed all five without changing IDs.
- `node apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs --write`: exit 0, 713 contracts, all 713 prior flows carried over.
- Final `npm run test:praxis-contracts`: exit 0, **“Praxis Tests: 713 Playwright tests catalogued and linked.”** No line-drift warnings.
- [Structured English catalog](catalog.json), [complete exact-source index](index.md).
- Scheduler Node source inventory: **90 literal test declarations**: domain 34, store 9, budget 14, runner 33. The stage handover guard adds two Node declarations. These are outside the generated catalog, and are not runtime result counts.

The catalog covers desktop Playwright only. Core, desktop Node suites, mobile
protocol/relay, Flutter and script checks are registered separately. A complete
monorepo automated execution count is not established by this generator.

## Curated contracts and acceptance coverage

Two existing enriched scheduling flows were retained. PT-ED816D0823 was enriched against its recovered assertions; all identifiers are preserved.
All Playwright automation below uses the `functional` project. Exact titles,
runner, files and lines are retained in catalog.json.

### PT-F32409778D — same-session allowance handover

Automation: Playwright [scheduledProviderHandover.spec.ts:21](../../apps/praxis-desktop/main/e2e/scheduledProviderHandover.spec.ts#L21),
“scheduled allowance handover checkpoints and continues the active stage in the same session”.

**Given** an isolated Electron application, temporary Git repository, held mock
gateway stage, fixture ACP provider below its allowance, and one scheduled ticket.
**When** a file is written into the active worktree and gateway usage reaches 95%.
**Then** exactly one handover is observed, its checkpoint contains the file,
workflow/session IDs survive, provider becomes codex-cli, the durable brief
revision increases, the workflow reaches awaiting-approval, and artifacts appear.
This exercises production integration with mocked providers, not paid-account
allowance measurement, approval completion, or next-ticket execution.

### PT-706E3FFD23 — explicit start pauses before launch

Automation: Playwright [scheduledRuns.spec.ts:728](../../apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts#L728),
“a due schedule starts by itself, and a provider at its allowance pauses it before anything launches”.

**Given** a persisted two-ticket schedule made overdue while closed and provider
usage of 97%. **When** the app reopens into Missed and the user chooses Start now.
**Then** budget pauses the schedule before any workflow exists; the monitor shows
95% threshold, 97% usage and two tickets; confirmed Stop creates a skipped report.
The title overstates unattended start; the updated flow describes actual assertions.

### Additional exact automation links

These Node contracts use `node:test` with fake runner ports and observations;
their titles below are exact. They do not assert live provider completion.

| Requirement / structured contract | Automation |
| --- | --- |
| Given three tickets, when predecessors succeed, then launches remain ordered and the attempt ends. | [scheduledRunRunner.test.ts:122](../../packages/core/src/scheduledRuns/scheduledRunRunner.test.ts#L122), “tickets run in order, each waiting for the one before to settle” |
| Given a workflow approval gate, when observed, then no successor launches and clearing it restores running. | [scheduledRunRunner.test.ts:140](../../packages/core/src/scheduledRuns/scheduledRunRunner.test.ts#L140), “a gate pauses the run, and it carries on by itself once the gate clears” |
| Given no provider below 95%, when ticking, then budget pauses with no launch. | [scheduledRunRunner.test.ts:271](../../packages/core/src/scheduledRuns/scheduledRunRunner.test.ts#L271), “budget: with no provider under 95% the run pauses and launches nothing” |
| Given an active ticket at 95%, when ticking, then the fake handover port is called and its checkpoint and provider are recorded. | [scheduledRunRunner.test.ts:280](../../packages/core/src/scheduledRuns/scheduledRunRunner.test.ts#L280), “mid-ticket hand-over at 95% records the brief, checkpoint and switch” |
| Given a threshold pause, when the active workflow still reports running, then the pause persists and a second ticket does not launch. | [scheduledRunRunner.test.ts:465](../../packages/core/src/scheduledRuns/scheduledRunRunner.test.ts#L465), “a threshold pause persists while the active turn still reports running” |
| Given checkpoint failure, when subsequent ticks occur, then its reason is retained and handover is called only once. | [scheduledRunRunner.test.ts:476](../../packages/core/src/scheduledRuns/scheduledRunRunner.test.ts#L476), “a failed handover pauses once instead of retrying each tick” |
| Given estimates and artifact references, when progress completes and storage is reopened, then estimates, artifacts and actual token spend survive. | [scheduledRunStore.test.ts:146](../../packages/core/src/scheduledRuns/scheduledRunStore.test.ts#L146), “ledger estimates and artifacts survive progress and a store restart” |
| Given a held stage waiter, when an intentional abort is followed by replacement execution, then only subsequent completion settles it. | [stageHandoverGuard.test.ts:5](../../apps/praxis-desktop/main/src/main/stageHandoverGuard.test.ts#L5), “intentional abort is held until the replacement turn is launched” |

Quit/minimise is indexed as **PT-6890A4393F**, Playwright
[scheduledRuns.spec.ts:862](../../apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts#L862),
“quitting with a schedule pending asks first, and offers to minimise instead”.

## Stale, ambiguous or incomplete evidence

1. The inherited report targeted `4de9ceb40d76f3c9ae714c55f4d7b906b996f94f`; updated to the required frozen snapshot. Five moved source links were refreshed. No duplicate IDs or file/title pairs were found.
2. Generator labels every entry `functional`; theme and live-agent routing must be read from [playwright.config.ts](../../apps/praxis-desktop/main/playwright.config.ts). Project metadata remains inaccurate for those entries.
3. Dynamic template titles and non-direct `test(...)` calls are not inventoried by this generator. The 713 count is the exact generated static inventory, not a claim of complete runtime case enumeration.
4. Most generated flows remain generic fixture/assertion boilerplate. Shape validation does not prove behavioral precision. The generator now preserves curated prose: the old report's assertion that enrichment would fail validation was stale.
5. IDs hash file path and title: line moves preserve them, file moves or title changes do not. Cross-file-move stability remains a tooling gap; no IDs were changed here.
6. PT-706E3FFD23 does not prove unattended timer firing: it explicitly starts a missed run. Core fake-clock tests support due-run logic, but are not real Electron unattended-start evidence. Missed schedules require a user choice rather than automatically firing after reopening.
7. Handover threshold is configurable; tests exercise both 95% and custom settings. Treat 95% as the default-policy contract, not an invariant for every setting.
8. No combined end-to-end assertion was identified here proving budget re-evaluation between each of multiple completed tickets; ordering and budget checks have separate evidence. No blanket claim is made that every ledger transition or allowance source is covered.
9. PT-8738E01F29 is opt-in visual capture. Catalog presence proves neither screenshot quality nor that capture ran.
10. Validator checks generated identities and nonempty flows, but not prose truth, runtime success, Markdown freshness or all top-level schema fields. Regeneration also refreshes the Markdown index.

## Returned QA findings: disposition

- Iterations 1, 2, 3 and 4: each supplied only npm exit 1 with no findings or underlying exception. They cannot be causally diagnosed from those excerpts; no unrelated repair was made in this stage.
- Iteration 5: opacity remained 0 when the test hovered the outer automation card. Frozen commit `a8d574e7` changes hover/click to the styled `.easymode-automation-row` child; CSS reveals actions through that child's `:hover` selector. The opacity, unchanged-title-width and action assertions remain intact. The implementation change-diff records a focused pass with loopback access after a sandbox EPERM attempt. That is inherited runtime evidence, not a fresh run in this contract stage.

### PT-ED816D0823 — recovered automation-row contract

Automation: Playwright, functional,
[easymode.spec.ts:874](../../apps/praxis-desktop/main/e2e/easymode.spec.ts#L874),
“automation rows have rename, archive, delete and run actions like a session row”.

**Given** an isolated Easy Mode app with a mocked succeeded Nightly Audit run and
recording rename/archive/delete IPC handlers. **When** its styled row is hovered,
clicked and left, then rename, archive and delete are used. **Then** actions reveal
without shrinking the title and hide after the pointer leaves; all four controls
are visible; Enter saves Weekly Audit; archive sends true; delete sends
`deleteWork: false` only after confirmation. The run control is not clicked:
this title does not establish run execution or real persistence of mocked mutations.
The catalog now records these exact limits rather than generic boilerplate.

No runtime suite was executed in this contract stage; fresh evidence consists of
source inspection, Playwright discovery and deterministic catalog validation.
Earlier report test:git results belong to an older stage and were removed from
the current-results section to avoid attributing them to this snapshot audit.

## Architecture and scope analysis

Core scheduled-run domain, budget, runner and store modules own durable queue
state and decisions. Electron scheduledRunRunnerInstance supplies workflow launch,
live observations and provider handover ports; scheduledRunLive adds usage,
estimates and artifact observations. The stage handover guard keeps intentional
interruption from settling the active workflow waiter. Exact regression links
above cover these boundaries through fake ports or isolated Electron fixtures.
The supplied patch and current assertions were inspected before edits.

The implementation plan for this stage was to verify snapshot identity, audit
source contracts and project discovery, preserve existing curated flows and IDs,
refresh this companion report, regenerate deterministically, and validate.
The report, catalog flow and five moved catalog/index links required updates. No generator expansion or test repair
is required to describe the snapshot accurately.

## Handoff boundaries

The required **test-contracts** report is this file. Catalog and index updates
are documentation only. No product/test code, workflow configuration, tracker
state or other stage was changed. Discovery did not execute journeys. No UI
changes or visual verification were performed in this stage. Runtime success
is not claimed by catalog validation.
