# test-contracts

Target: PRX-S47-148, frozen implementation `4de9ceb40d76f3c9ae714c55f4d7b906b996f94f`.
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
- Initial validator exited 0 with no stale source-line warnings. The prior contract stage already repaired the 43 moved links; this snapshot retains those repairs.
- `node apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs --write`: exit 0, 713 contracts, all 713 prior flows carried over.
- Final `npm run test:praxis-contracts`: exit 0, **“Praxis Tests: 713 Playwright tests catalogued and linked.”** No line-drift warnings.
- [Structured English catalog](catalog.json), [complete exact-source index](index.md).
- Scheduler Node source inventory: **90 literal test declarations**: domain 34, store 9, budget 14, runner 33. The stage handover guard adds two Node declarations. These are outside the generated catalog, and are not runtime result counts.

The catalog covers desktop Playwright only. Core, desktop Node suites, mobile
protocol/relay, Flutter and script checks are registered separately. A complete
monorepo automated execution count is not established by this generator.

## Curated contracts and acceptance coverage

Two existing enriched catalog flows were checked against their assertions and retained unchanged; all identifiers are preserved.
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

1. The inherited companion report targeted `fc1c5ca0a0abfb169eea7bbc781d4f8acb5cf5f7`; updated to the required frozen snapshot. The catalog is already current: no stale links or duplicate IDs were found in this iteration.
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

The frozen implementation adds `pretest:git: node -e "require('electron')"`
in desktop-main/package.json. This resolves Electron before Node test workers
start; it does not exercise application behavior or prove the cause of earlier
worker failures. The provided QA excerpts omit their underlying exceptions.
Iterations 1–3 report npm exit 1 without actionable root-cause evidence;
no causal diagnosis can be established for those iterations from the excerpts.

Fresh command: `npm run test:git --workspace=@praxis/desktop-main` exited **1**.
Compilation and the new preload hook succeeded. The suite recorded **80 passed,
4 failed, 84 total**. All four failures were local HTTP fixture binds in
`semanticModelDownload.test.js`: `listen EPERM: operation not permitted 127.0.0.1`.
No retry or unrelated repair was attempted in this catalog stage.
Full [command log](../../.praxis/session-artifacts/test-contracts-test-git.log).

| Iteration 4 returned finding | Current disposition |
| --- | --- |
| `gitService.test.js` failed | Passed in the fresh exact-command rerun; no test or product repair in this stage. Earlier failure cause remains unproven. |
| `minimaxUsage.test.js` failed | Passed in the fresh exact-command rerun; no test or product repair in this stage. Earlier failure cause remains unproven. |
| `ticketReviewApply.test.js` failed | Passed in the fresh exact-command rerun; no test or product repair in this stage. Earlier failure cause remains unproven. |
| `windowBroadcast.test.js` failed | Passed in the fresh exact-command rerun; no test or product repair in this stage. Earlier failure cause remains unproven. |
| `windowState.test.js` failed | Passed in the fresh exact-command rerun; no test or product repair in this stage. Earlier failure cause remains unproven. |

Historical recovery reports mention 84 passing tests with loopback access; those
results are inherited evidence and do not replace this stage's failing rerun.
The remaining environment failure means the broad Node suite is not green here.
No tests were weakened, skipped or edited to address the findings.

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
Only docs/praxis-tests/test-contracts.md and the retained command log required updates; catalog.json and
index.md regeneration produced no changes. No generator expansion or test repair
is required to describe the snapshot accurately.

## Handoff boundaries

This report and its retained command log are the stage artifacts; deterministic
catalog/index regeneration produced no changes. No product/test code, workflow
configuration, tracker state or other stage was changed. Node test execution is
reported above; Playwright discovery did not execute journeys. No UI changes or
visual verification were performed. The required artifact is this **test-contracts**
report. Catalog validation passes; broad QA remains limited by the recorded
sandbox loopback failures.
