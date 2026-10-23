# test-contracts

Frozen implementation: `93fed4f2969e6eb93ca748e76f81b6013a588171` (PRX-F47).
The checkout was clean at HEAD `0414a49ba7513bc2f47ac90e8e1a84ec82ae0798` before this report was updated. A full snapshot-to-HEAD comparison showed only this companion report differed; all implementation files, test sources, scripts, configuration, and generated catalog files matched the frozen snapshot. Validation therefore used snapshot-identical inputs without switching the live branch.
Inspected `.praxis/change-diff.md`, the commit diff, generator, catalog, Playwright configuration, scheduler spec, and test script registrations before editing.

## Inventory and validation

- **695 source contracts across 153 Playwright spec files**, including **18 scheduled-run contracts**. Zero duplicate IDs and zero duplicate source-file/title pairs.
- `npm run test:praxis-contracts`: exit 0, “Praxis Tests: 695 Playwright tests catalogued and linked.” Existing generated catalog is current; no regeneration or identifier changes needed.
- `npx playwright test --list` from `apps/praxis-desktop/main`: exit 0, **705 project executions in 153 files**. This is discovery, not a test pass count.
- [Generated structured contracts](catalog.json) and [complete source-link inventory](index.md).
- IDs are SHA1-derived from source path plus title. Line shifts preserve IDs; file moves or title changes do not. Existing generated IDs were preserved. Renames would require generator support to retain identity; the current algorithm does not meet the file-move stability requirement.
- The generated inventory covers desktop Playwright only. Root test scripts also register core Node, desktop Git/workflow/mobile Node, skills, consent, and mobile protocol/relay checks. These are outside the generator's scope; 695 must not be reported as the whole monorepo's automated-test count. The four scheduler core source files contain **69 literal test declarations** (33 domain, 7 store, 9 budget, 20 runner); these are additional source inventory, not executed results.

## Curated recovery contracts

All automation below uses Playwright, project `functional`. Exact titles and stable IDs remain in the generated catalog.

### PT-74238ECE73 — missed run requires a choice

Automation: [scheduledRuns.spec.ts:187](../../apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts#L187), “a start that passed while Praxis was closed is missed, and only a choice resolves it”.

**Given** two armed schedules saved through IPC, an acknowledged quit warning, and their persisted timestamps rewound while the app is closed.

**When** Praxis reopens and the user chooses Skip for one and Start now for the other.

**Then** both initially show Missed in the attention group; one becomes Skipped; the other leaves Missed, no longer displays 2020, and has no start-in-past diagnostic. This does not prove successful completion of launched work.

### PT-706E3FFD23 — allowance gate after explicit missed-run start

Automation: [scheduledRuns.spec.ts:728](../../apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts#L728), “a due schedule starts by itself, and a provider at its allowance pauses it before anything launches”.

**Given** an armed two-ticket schedule, injected provider usage of 97%, and a persisted due timestamp set while closed.

**When** Praxis reopens, marks the schedule Missed, and the user clicks Start now and opens the monitor.

**Then** the schedule pauses for budget, no workflow run exists, the banner names the 95% threshold, the processor is waiting, usage reads 97%, and two tickets remain on the belt. Confirming Stop produces a Skipped report with two rows.

### PT-9EBCCE6CC4 — launch failure, skip, and resume

Automation: [scheduledRuns.spec.ts:766](../../apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts#L766), “a ticket that cannot be launched pauses the run with the reason, keeps its order, and can be skipped”.

**Given** two tickets, an approval-only workflow, provider usage at 10%, and an uncommitted file in the base repository.

**When** the user starts the missed run, skips the blocked ticket, removes the uncommitted file, and resumes.

**Then** the pause names the uncommitted file; initially no workflow exists and both entries remain queued; skipping records one skipped entry; after clearing the cause and resuming exactly one workflow run exists. This proves launch, not successful agent completion.

## Additional core coverage links

These Node tests use a fake clock, store and workflow observations; they prove runner logic rather than a live Electron timer or provider completion. They are registered in `packages/core/package.json`, outside the generated Playwright IDs.

- [scheduledRunRunner.test.ts:91](../../packages/core/src/scheduledRuns/scheduledRunRunner.test.ts#L91), “a due run starts once and launches only the first ticket”: **Given** a due harness schedule, **When** the runner ticks twice, **Then** only T-1 launches and only one attempt exists.
- [scheduledRunRunner.test.ts:122](../../packages/core/src/scheduledRuns/scheduledRunRunner.test.ts#L122), “tickets run in order, each waiting for the one before to settle”: **Given** three queued tickets, **When** ticks observe each predecessor succeeding, **Then** launch order is T-1, T-2, T-3 and the schedule completes with an ended attempt.
- [scheduledRunRunner.test.ts:140](../../packages/core/src/scheduledRuns/scheduledRunRunner.test.ts#L140), “a gate pauses the run, and it carries on by itself once the gate clears”: **Given** an active first ticket, **When** its workflow reports an approval gate then running, **Then** the schedule pauses without another launch, rejects manual resume through the gate, and returns to running after the gate clears.

## QA return dispositions

The frozen commit changes only `.praxis/change-diff.md`; it documents an implementation-stage rerun, not a source fix. This contracts stage did not rerun `test:git` and does not independently certify recovery.

| Reported failure | Disposition at the frozen snapshot |
| --- | --- |
| `autoUpdate.test.js` | Implement reports it passed in the rerun; no source change. Original truncated failure cause remains unproven. |
| `gitService.test.js` | Implement reports it passed in the rerun; no source change. Original truncated failure cause remains unproven. |
| `ticketReviewApply.test.js` | Implement reports it passed in the rerun; no source change. Original truncated failure cause remains unproven. |
| `windowBroadcast.test.js` | Implement reports it passed in the rerun; no source change. Original truncated failure cause remains unproven. |
| Iterations 1–5, “npm exited 1” without findings | Insufficient diagnostics to attribute a defect or claim resolution for any individual run. No speculative fix. |

[Implement recovery evidence](../../.praxis/change-diff.md) records compile success, **74 passed / 4 failed**, with the four failures in `semanticModelDownload.test.js` at HTTP fixture startup (`listen EPERM` on `127.0.0.1`). Therefore broad QA is still unresolved: rerun those fixtures where loopback binding is permitted. This report does not establish that the original four file failures had the same cause.

## Stale or ambiguous contracts and coverage findings

- **Misleading automatic-start title:** PT-706E3FFD23 explicitly clicks Start now after reopening into Missed. It does not prove unattended firing while the app stays open. The curated contract above states the actual evidence; the frozen source title and ID are preserved.
- **Generic generated prose:** all generated Given/Then fields describe fixture setup and assertion success without specifying the asserted behavior. The validator enforces exact generated entries, so hand-enriching those JSON flows would fail validation. Curated contracts live here instead; generator enrichment support is outside this stage's necessary scope.
- **Incorrect project metadata:** the generator hardcodes `functional` for every entry, while Playwright routes appearance, theme-tagged, and live-agent tests to other projects. Source links/counts validate, but runner-project metadata is ambiguous outside functional tests. Configuration is the authority.
- **Incomplete suite scope:** Node tests are registered but not represented in the generated Playwright catalog. No complete monorepo runtime test count is claimed.
- **Opt-in coverage:** PT-8738E01F29 at scheduledRuns.spec.ts:394 skips unless `PRAXIS_SHOTS` is set. Catalog presence does not prove that visual capture ran.
- **Validator limits:** validates JSON test count and exact entries, not Markdown index freshness, top-level schema metadata, actual assertion quality, or runtime success. No stale source links or duplicate IDs were found in the current generated entries. Regenerating both catalog files produced no changes, independently checking Markdown freshness.

No product/test code or workflow definitions changed. No stages advanced, tracker comments posted, or UI verification performed. This stage ran deterministic catalog validation and test discovery only; inherited implementation test claims were not treated as new execution evidence.

## Stage verification record

- `npm run test:praxis-contracts` from the repository root exited 0 with 695 linked tests.
- `npx playwright test --list --reporter=json` from desktop-main exited 0: 705 project executions and no discovery errors; no automated journeys were executed in this stage.
- `node apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs --write` exited 0 and produced no catalog or index diff. Independent inventory checks confirmed 153 files, 18 scheduler contracts, zero duplicate IDs, zero duplicate source/title pairs, and 69 literal scheduler Node test declarations.
- Required artifact: this `test-contracts` report. Only this companion report changed; the deterministic catalog and index remained current.
