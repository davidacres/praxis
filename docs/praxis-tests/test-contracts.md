# test-contracts

Target: PRX-S47-148, frozen implementation `00ba06920e696caecae7908025e16e61b5f49988`.
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

1. The inherited companion report targeted `960e78c8`; updated to the required frozen snapshot. The catalog is already current: no stale links or duplicate IDs were found in this iteration.
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

The frozen `.praxis/change-diff.md` recovery section records an exact-command
rerun of `npm run test:git --workspace=@praxis/desktop-main`, with **84 passed,
0 failed** when loopback access was available. This is inherited implementation
verification, not a fresh execution by this contract stage. The supplied QA
excerpt contains file-level failures without underlying exception details, so
it does not independently establish a common root cause for the five files.

| Returned finding | Addressed in frozen implementation / remaining limit |
| --- | --- |
| `autoUpdate.test.js` failed | Recovery records this file passing in the exact-command rerun; no product change was made. Not rerun in this stage. |
| `gitService.test.js` failed | Recovery records this file passing in the exact-command rerun; no product change was made. Not rerun in this stage. |
| `minimaxUsage.test.js` failed | Recovery records this file passing in the exact-command rerun; no product change was made. Not rerun in this stage. |
| `ticketReviewApply.test.js` failed | Recovery records this file passing in the exact-command rerun; no product change was made. Not rerun in this stage. |
| `windowState.test.js` failed | Recovery records this file passing in the exact-command rerun; no product change was made. Not rerun in this stage. |

The recovery also records four restricted-environment failures in
`semanticModelDownload.test.js` from `listen EPERM` on `127.0.0.1`, followed by a
permitted passing run. Referenced recovery command logs are absent from this
snapshot's `.praxis/session-artifacts/` directory, which contains only the patch;
therefore the recorded 84-pass recovery is not independently corroborated here.
No tests were weakened, skipped or edited to address these findings.

## Handoff boundaries

Only this report changed; deterministic catalog/index regeneration produced no changes. No product/test code, workflow
configuration, tracker state or other stage was changed. No automated journeys
were executed in this catalog stage, and no UI/visual verification was performed.
Inherited test results in change-diff are historical evidence, not fresh passes.
The required artifact is this **test-contracts** report.
