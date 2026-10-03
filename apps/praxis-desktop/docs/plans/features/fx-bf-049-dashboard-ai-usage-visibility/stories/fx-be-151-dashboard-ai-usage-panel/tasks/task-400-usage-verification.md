---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-400
type: Task
status: Backlog
created: 2026-10-03
priority: High
---

# Prove the usage panel end to end and document it

## Files and integration points

A new e2e spec beside the existing `overview.spec.ts` in the desktop Playwright
suite; `main/e2e/launchTestApp.ts` and its throwaway test profile for seeding;
and the usage row in `apps/praxis-desktop/docs/desktop-feature-parity.md`.

## Scope

Seed `ai-usage-log.json` into the throwaway test profile with a known, hand-checked
set of events — several models, more than one provider, at least one model with
no reported cost, and events in more than one period — then assert the exact
figures the panel renders. Not a smoke test that the panel exists: exact tokens,
cost and peak values per period, correct model ranking and share, and "not
reported" where cost is absent.

Confirm the e2e suite still loads the pre-built renderer, so `desktop:copy-renderer`
runs before it; a frontend change is invisible to e2e until the renderer is
rebuilt and copied.

No test may point a Praxis write path at the working tree — the seeded ledger
belongs in the throwaway profile only.

Update the usage row in `docs/desktop-feature-parity.md` to state that AI usage
is visible on the Overview dashboard, and note that the dashboard total
deliberately differs from Settings → AI → Spend because Spend reads
`AgentSessionRecord`s and excludes internal one-shot AI calls.

## Dependencies

TASK-398, TASK-399

## Done conditions and validation

`npm run test:core` for the aggregation tests, `npm run check-types` across
workspaces, `npm run build`, and the full `npm run test:desktop` pass. Open every
updated snapshot's `-actual.png` and read the diff before accepting it — never
assume a snapshot update is safe. Visually inspect the running app in all four
theme axes and at all three panel states, and retain useful screenshots under
`.praxis/session-artifacts/`. Report which e2e tests passed, which snapshots
changed and why, and which manual interactions verified the panel.

## Description


## Comments
