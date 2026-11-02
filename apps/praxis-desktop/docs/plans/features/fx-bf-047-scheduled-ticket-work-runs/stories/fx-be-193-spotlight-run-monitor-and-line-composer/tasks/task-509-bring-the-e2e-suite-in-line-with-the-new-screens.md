---
**Status:** 📋 To Do
**Created:** 2026-11-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-509
title: Bring the e2e suite in line with the new screens
status: To Do
story: FX-BE-193
updated: 2026-11-02
dependencies: [TASK-507, TASK-508, TASK-466]
validation: [npm run check-types, npm run build, npm run test:desktop:smoke, npm run test:desktop]
---

# Bring the e2e suite in line with the new screens

## Goal

The final gate for FX-BE-193. After the monitor, composer and report changes,
every e2e spec that touches scheduled runs passes, and no assertion was
weakened to get there.

## Done when

- `TASK-507` and `TASK-508` each updated their own tests in the same change
  (see their "E2E updates"). This task confirms the whole suite, not one file.
- `e2e/scheduledRuns.spec.ts` passes in full: 32 declared tests, 33 runs,
  because the one-lane test (1204) runs for two cases. That includes the
  unchanged lineup, board entry point, quit warning and ledger tests (190, 243,
  250, 259, 281, 307, 903, 1041, 1223).
- Test 769's report assertions (`schedule-report-status`,
  `schedule-report-table`) match the report as rebuilt by `TASK-466`.
- `scheduledProviderHandover.spec.ts` (smoke set) passes.
- The specs that only mention scheduled runs still pass:
  `titlebarLayout.spec.ts`, `titlebarMinimal.spec.ts`, `easymode.spec.ts`,
  `agentHub.spec.ts`, `sessionSkillUsage.spec.ts`.
- `npm run test:desktop:smoke` and `npm run test:desktop` are green, apart from
  the known stale failures recorded before this work started (record which
  ones on the day, and run them on `HEAD` to show they fail there too).
- A grep of `e2e/` finds no test id the renderer no longer renders:
  every `schedule-*` id used in a spec exists in `renderer/src/schedule/`.
- No test was deleted or skipped. Where an assertion changed, the PR or commit
  message says what it checks now and why that is the same behaviour.

## Notes

- Build before running: `npm run build:core`, `npm run build:renderer`,
  `npm run desktop:copy-renderer`. Otherwise e2e runs the old renderer.
- The bundled `praxis-scheduled-runs` skill (`packages/core/src/ai/agentRuntime/bundledAgents.ts`)
  covers request files, not the screens, and names no belt or processor. It
  needs no change. Re-check this if UI wording is ever added to it.

## Dependencies

- `TASK-507`
- `TASK-508`
- `TASK-466`

## Description


## Comments

