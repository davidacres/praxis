# test-contracts

Frozen implementation: `0408661dad4893ee7e48294facff4e19c4175bee` (PRX-F47).
The checkout HEAD matched this snapshot and was clean before this report was added.
Inspected `.praxis/change-diff.md`, the commit diff, generator, catalog, Playwright configuration, scheduler spec, and test script registrations before editing.

## Inventory and validation

- **695 source contracts across 153 Playwright spec files**, including **18 scheduled-run contracts**. Zero duplicate IDs and zero duplicate source-file/title pairs.
- `npm run test:praxis-contracts`: exit 0, “Praxis Tests: 695 Playwright tests catalogued and linked.” Existing generated catalog is current; no regeneration or identifier changes needed.
- `npx playwright test --list` from `apps/praxis-desktop/main`: exit 0, **705 project executions in 153 files**. This is discovery, not a test pass count.
- [Generated structured contracts](catalog.json) and [complete source-link inventory](index.md).
- IDs are SHA1-derived from source path plus title. Line shifts preserve IDs; file moves or title changes do not. Preserve the existing IDs in this companion catalog.
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

## QA return dispositions

1. **Missed-run failure near former line 190:** snapshot now uses `quitWithArmedSchedule` to acknowledge Quit anyway and wait for close before editing persisted storage (helper at line 82; call at line 199). The 2020 timestamp deliberately bypasses save validation as a closed-app fixture. Static recovery is present. The supplied error is truncated and does not establish the original root cause conclusively; runtime resolution is not verified by this stage.
2. **Due-schedule save rejected as past:** `scheduleSoon` now rounds the requested delay plus 60 seconds upward to a minute before saving (line 684), avoiding loss of seconds into a past minute. Subsequent due-time rewrites occur after confirmed quit. Static fix is present; runtime resolution is not verified here.
3. **Iterations 1–3:** only “npm exited 1” and no findings were supplied. There is no actionable failure detail to disposition or evidence to claim those runs passed.

## Stale or ambiguous contracts and coverage findings

- **Misleading automatic-start title:** PT-706E3FFD23 explicitly clicks Start now after reopening into Missed. It does not prove unattended firing while the app stays open. The curated contract above states the actual evidence; the frozen source title and ID are preserved.
- **Generic generated prose:** all generated Given/Then fields describe fixture setup and assertion success without specifying the asserted behavior. The validator enforces exact generated entries, so hand-enriching those JSON flows would fail validation. Curated contracts live here instead; generator enrichment support is outside this stage's necessary scope.
- **Incorrect project metadata:** the generator hardcodes `functional` for every entry, while Playwright routes appearance, theme-tagged, and live-agent tests to other projects. Source links/counts validate, but runner-project metadata is ambiguous outside functional tests. Configuration is the authority.
- **Incomplete suite scope:** Node tests are registered but not represented in the generated Playwright catalog. No complete monorepo runtime test count is claimed.
- **Opt-in coverage:** PT-8738E01F29 at scheduledRuns.spec.ts:394 skips unless `PRAXIS_SHOTS` is set. Catalog presence does not prove that visual capture ran.
- **Validator limits:** validates JSON test count and exact entries, not Markdown index freshness, top-level schema metadata, actual assertion quality, or runtime success. No stale source links or duplicate IDs were found in the current generated entries.

No product/test code or workflow definitions changed. No stages advanced, tracker comments posted, or UI verification performed. This stage ran deterministic catalog validation and test discovery only; inherited implementation test claims were not treated as new execution evidence.
