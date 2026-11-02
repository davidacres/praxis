---
**Status:** 📋 To Do
**Created:** 2026-11-02T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-193
title: Spotlight run monitor and Line composer
status: To Do
feature: FX-BF-047
updated: 2026-11-02
tasks: [TASK-504, TASK-505, TASK-506, TASK-507, TASK-508, TASK-509]
dependencies: [FX-BE-148, FX-BE-149, FX-BE-173]
validation: [npm run check-types, npm run build:core, npm run build:renderer, npm run desktop:copy-renderer, npm run test:core, npm run test:desktop]
---

# Spotlight run monitor and Line composer

Parent feature folder: `fx-bf-047-scheduled-ticket-work-runs`

## User or operational impact

Watching a scheduled run should show every ticket that is in flight and, for
each one, every agent task in its workflow with its own status, not one stage
label for one ticket. Scheduling a run should show how the night is likely to
go, in the same picture the monitor will use.

## Design

Chosen on 2026-11-02 from five directions on the design canvas
(https://claude.ai/artifact/ALm5NWJ25ZEWCbTNCmQhk4, private to the owner):

- **Run monitor: "D · Spotlight"** (board `D-Spotlight-Monitor`). A row of
  beads for every ticket, grouped by step. Up next is a deck on the left,
  in-flight tickets are large cards in the middle (one per lane), and
  finished tickets become receipts on the right. Each in-flight card lists the
  workflow's tasks (for Governed delivery: Plan, Implement, Review, Test
  contracts, Install, Build, Security, QA, Approve) with state, attempts and
  time, plus a "now" line. An approval, failure or trust decision appears on
  the card it is about.
- **New scheduled run: "A · The Line" in Spotlight's look** (board `F-New`).
  Ticket picker, steps as bays (tickets in one bay share a step), readiness
  warnings on the ticket they concern, and a rehearsal that plays the
  forecast on the same bead row the monitor uses.
- **Run report** (board `F-Report`): needed you, worth knowing, receipts with
  one bar per agent task, where the time went. This is the target for
  `TASK-466`.

The canvas runs on a scripted simulation. The real screens show only what the
runner and the workflow engine record (see Constraints).

## Scope

- Live detail for **every** active entry, not just one (`TASK-504`).
- A "now" line per in-flight stage built from recorded events (`TASK-505`).
- A forecast shared by the composer and the monitor (`TASK-506`).
- The Spotlight monitor (`TASK-507`) and the Line composer (`TASK-508`).

## What exists and what is missing

Checked against the code on 2026-11-02.

| The design needs | Today | Gap |
| --- | --- | --- |
| Per-task state, attempts, provider, duration for a ticket | `summarizeWorkflowRun(...).stages` (`StageRow`: lane, attempts, provider, durationMs, lastError, findings, sessionId) | Not sent to the renderer for scheduled runs |
| Detail for every in-flight ticket (lanes) | `ScheduledRunView.live` holds one entry (`describeLiveEntry`) | Make it one per active entry |
| Elapsed time of the running task | Attempt `startedAt` on `WorkflowNodeState.attempts` | `StageRow` has no `startedAt` for the in-flight attempt |
| Tokens per task | `AiUsageEvent.workflowNodeId` is logged | Not summed per node (`spendFor` sums per run) |
| "Now" line | `node-progress` events; agent session events | No short derived line |
| Likely finish, slow finish, spend range | `estimateWorkflowRun` per run; lane rules in the runner | No whole-schedule forecast |
| Loops, hand-overs, repairs, approvals for the report | `loopHistory`, run events, `ScheduledHandover`, schedule events | Already readable. Report work is `TASK-466` |
| Readiness on the ticket | `ScheduledRunReadiness.issues[].entryId` | Composer shows them as one list |

## Constraints

- Never animate progress the runner has not reported. A running task shows
  elapsed time, not a percentage. The "now" text is recorded text, revealed at
  most once. No made-up activity.
- Motion respects reduced motion. Cards move between deck, stage and receipts
  with a transition, and appear in place when reduced motion is on.
- The renderer imports types only from core (`npm run check-core-imports`).
  Forecast and activity rules live in core and run in main.
- No new theme tokens. Use the existing lane and tone tokens (`--lane-*`,
  `--tone-*`) so all theme axes inherit.

## E2E tests that use these screens

Inventoried on 2026-11-02. Each screen change ships **in the same change** as
its test updates (inside `TASK-507` / `TASK-508`), so the suite is never left
red between tasks. `TASK-509` is the final whole-suite gate. None of these
tests uses `toHaveScreenshot`; the `.png` files they write are for review only,
so no baselines need regenerating. They do need inspecting again.

**`e2e/scheduledRuns.spec.ts` — run monitor (changed by `TASK-507`)**

| Line | Test | Selectors that change |
| --- | --- | --- |
| 769 | a due schedule starts by itself … provider at its allowance pauses it | `schedule-processor`, `schedule-belt`, `schedule-budget`, `schedule-pause-banner` |
| 807 | Run now starts drafts … opens the live view | `schedule-monitor`, `schedule-monitor-back` |
| 831 | the hand-over point is a setting … | `schedule-monitor` |
| 848 | the editor can Run now … obeys the provider budget gate | `schedule-monitor`, `schedule-belt`, `schedule-pause-banner` (+ composer ids) |
| 865 | a ticket that cannot be launched pauses the run … can be skipped | `schedule-pause-banner`, `schedule-done-tray`, `schedule-skip-entry`, `schedule-resume` |
| 920 | an idle failed stage pauses the schedule and retries … | `schedule-proc-state`, `schedule-stage-failure`, `schedule-retry`, `schedule-retry-stage`, `schedule-review-workflow`, `schedule-pause-banner` |
| 960 | the stage-failure panel names the stage it shows … | `schedule-proc-state`, `schedule-stage-failure` |
| 1007 | a workflow whose check stage needs a tool that is not installed … | `schedule-pause-banner` |
| 1168 | two independent tickets run at once within the cap … | `schedule-lanes-panel`, `schedule-lane`, `schedule-lane-reason`, `schedule-lanes-waiting` |
| 1204 | `${label}` keeps the run to one lane and says why | `schedule-activity` |
| 1265 | a parallel run whose readiness is blocked starts nothing … | `schedule-lanes-panel`, `schedule-pause-banner` |
| 1282 | a schedule paused on an untrusted workflow offers to review and trust it | `schedule-pause-banner`, `schedule-trust-workflow` |

**`e2e/scheduledRuns.spec.ts` — composer (changed by `TASK-508`)**

| Line | Test | Selectors that change |
| --- | --- | --- |
| 94 | builds a schedule on the belt, saves it, and it survives a restart | `schedule-count`, `schedule-readiness`, `schedule-ready`, `schedule-name` |
| 154 | edit, schedule, hold and delete a schedule | `schedule-belt-card` |
| 229 | a run with no usable provider cannot be scheduled, and says why | `schedule-readiness`, `schedule-save` |
| 315 | tickets can be dragged from the hopper onto the flow graph and reordered | `schedule-belt-card/-key/-slot/-title`, `schedule-flow-step` |
| 349 | a ticket dropped onto another shares its step … | `schedule-flow-step/-bar/-rails/-join-preview`, `schedule-belt-seq/-title`, `schedule-summary` |
| 416 | dragging a group ticket from the scheduler sidebar adds its children | `schedule-belt`, `schedule-belt-card` |
| 462 | capture the composer and lineup for visual review (opt-in) | `schedule-readiness`, `schedule-ready` |
| 510 | scheduled runs have a grouped sidebar … | `schedule-belt`, `schedule-belt-card`, `schedule-ready` |
| 634 | sidebar uses classic recency groups and expands group tickets | `schedule-belt`, `schedule-belt-card`, `schedule-ready` |
| 1069 | an agent request file becomes an ordered draft … | `schedule-cancel` (composer opened from the request) |
| 1137 | parallel lanes are a deliberate choice in the editor … | `schedule-lanes`, `schedule-lanes-warning`, `schedule-summary`, `schedule-flow-step`, `schedule-belt-card` |

The run report (`ScheduleRunReport.tsx`) is read by test 769
(`schedule-report-status`, `schedule-report-table`). It changes under
`TASK-466`, which must update that test the same way.

**Unchanged, but must still pass:** in `scheduledRuns.spec.ts`, tests 190,
243, 250, 259, 281, 307, 903, 1041 and 1223. They cover the lineup page, board
entry points, the quit warning and the ledger, and use no monitor or composer
selectors. Also unchanged: `scheduledProviderHandover.spec.ts` (in the smoke
set; asserts on the run ledger, not the UI), `titlebarLayout.spec.ts`,
`titlebarMinimal.spec.ts`, `easymode.spec.ts`, `agentHub.spec.ts`,
`sessionSkillUsage.spec.ts` (titlebar shortcut, page id and skill only), and
the schedule clean-up in `launchTestApp.ts`.

**Selector rule:** keep a test id wherever its meaning survives, so tests
change only where the screen really changed. For example: a bay keeps
`schedule-flow-step`, a ticket card in a bay keeps `schedule-belt-card`, and the
monitor root keeps `schedule-monitor` and `data-status`. Decisions that move
onto a card keep their ids (`schedule-approve`, `schedule-retry`,
`schedule-skip-entry`, `schedule-trust-workflow`), scoped inside the card. New
ids for new parts: `schedule-rail`, `schedule-deck`, `schedule-flight-card`
(with `data-issue` and `data-entry-status`), `schedule-task-row` (with
`data-node` and `data-lane`), `schedule-receipt`, `schedule-rehearsal`. Remove
an id only together with the assertions that used it, and replace those
assertions with ones that check the same behaviour.

## Acceptance criteria

- With up to 4 lanes, each in-flight ticket has its own card and task list,
  and the list matches the workflow run's stages.
- A loop back from Review shows Implement running again and Review re-queued,
  with the attempt count.
- An approval gate, a failed stage and an untrusted workflow each put their
  decision on the affected card, using the existing schedule APIs.
- The composer's likely finish and the monitor's likely finish come from the
  same core forecast.
- Existing `scheduledRuns.spec.ts` scenarios still pass (selectors updated
  where the layout changed) and new screenshots are inspected.

## Task list

- `TASK-504` — Send live detail for every active entry.
- `TASK-505` — Derive a recorded "now" line per running stage.
- `TASK-506` — Forecast a schedule's finish and spend in core.
- `TASK-507` — Build the Spotlight run monitor.
- `TASK-508` — Rebuild the composer as the Line in Spotlight's look.
- `TASK-509` — Bring the e2e suite in line with the new screens (final gate).

## Validation

- Core unit tests for the live detail, the activity line and the forecast.
- Desktop E2E with the fake agent fixtures: two lanes running, a loop back, an
  approval on a card, a failed stage with Retry, the run completing.
- Screenshots of each state, inspected against the canvas boards.

## Close when

A user can schedule a run on the Line, see its rehearsal, then watch every
in-flight ticket's agent tasks progress on the Spotlight monitor and act on
decisions from the card.

## Dependencies

- `FX-BE-148` — runner, pauses and hand-over.
- `FX-BE-149` — bounded parallel lanes.
- `FX-BE-173` — current monitor and report (`TASK-466` becomes the report half
  of this design).

## Description


## Comments

