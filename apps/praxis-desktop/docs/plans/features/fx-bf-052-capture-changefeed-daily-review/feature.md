---
**Status:** Done
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-052
slug: capture-changefeed-daily-review
title: Quick Capture, What Changed, and Daily Review
status: Done
created: 2026-10-04
priority: Medium
---

# FX-BF-052: Quick Capture, What Changed, and Daily Review

## Outcome

Praxis gains three lightweight, always-available planning surfaces:

1. **Quick capture** — jot a task from anywhere in the app without leaving the current context.
2. **What changed?** — a summarized view of recent project updates (tickets, plans, sessions, git).
3. **Daily review** — a short, focused surface that surfaces overdue and blocked work.

Together these close the loop between capturing intent, understanding project motion, and acting on stalled work — the highest-frequency daily interactions that currently have no first-class UI.

## Why

1. Capture friction: ideas arrive while looking at a diff, board, or session; forcing navigation to a board drops context and the thought.
2. Change blindness: with plans, sessions, git, and tickets all moving, there is no single "what happened since I last looked" summary.
3. Stalled work hides: overdue and blocked tickets sit quietly on the board instead of being surfaced in a deliberate daily moment.

## Story map

- [FX-BE-158: Quick capture box](stories/fx-be-158-quick-capture-box/story.md)
- [FX-BE-159: What changed view](stories/fx-be-159-what-changed-view/story.md)
- [FX-BE-160: Lightweight daily review](stories/fx-be-160-lightweight-daily-review/story.md)

## Non-goals

1. No AI summarization requirements in v1 (deterministic summaries first; AI polish is a follow-up).
2. No notifications/scheduling; the daily review is opened deliberately.
3. No cross-project aggregation; scoped to the active project in v1.

## Dependencies

Reuses the existing project/ticket data layer (folder-backed `docs/` tree and board store). No blocking dependencies on in-flight features.

## Close conditions

All three stories meet their acceptance criteria; the three surfaces are reachable within one interaction from anywhere; `npm run check-types` and existing desktop E2E pass with new coverage included.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |

## Description


## Work order and readiness — 2026-10-11

**5 of 5** in the reviewed ticket set, after PRX-F45 evidence reconciliation. The following readiness work is complete; see the closeout below for the remaining full-suite gate. These clarify the three existing stories; they do not add a new feature.

- [x] FX-BE-158: specify behavior with no active project and with a backend that cannot create tickets. Reuse existing creation permissions and validation; do not silently choose another project or backend. Preserve input and show an actionable error on failed submission; clear input only after successful creation. Treat captured text as untrusted content.
- [x] FX-BE-159: document which existing sources retain history, the supported retention window and behavior when history is unavailable. Scope events and links to the active project; omit secrets and tokens from event payloads and displayed content.
- [x] FX-BE-160: define the aging threshold/default, the timestamp it measures, timezone/date boundaries, excluded Done stages and behavior when dates are missing. Mutations must reuse existing workflow and permission checks.
- [x] Carry these decisions into the existing story acceptance criteria and cover failure, permission, project-isolation and date-boundary cases in verification before implementation starts.

Decisions taken 2026-10-11 (recorded in each story's Comments): history retained 30 days / 1,000 entries per project; inactive = 7 whole days since last recorded activity; undated items are never flagged; Done-category stages excluded.

Delivery order within this feature: Quick Capture, What Changed, then Daily Review. Completing Quick Capture alone does not complete PRX-F52; all three stories remain required.

## Comments



### 2026-10-11 — closeout status and verification

All three stories are Done with their focused tests passing in the existing full run. The feature remains In Progress because its close conditions require a green full desktop suite: the run finished with 590 passed, 3 skipped and 1 failure in `workflowModelTiers.spec.ts` (provider-row model-tier assertion). Do not describe the suite as green. No E2E rerun was requested or performed during this closeout.

The existing detached run (`/tmp/sd3-full.log`) finished: **590 passed, 3 skipped, 1 failed**. These are prior-run results, not a new run. E2E tests were not run during this closeout, as requested.

### 2026-10-11 — user-directed closure; verification deferred

Closed as Done at the user's request to close features whose remaining gaps are verification only. FX-BE-158, FX-BE-159 and FX-BE-160 were already Done with recorded focused-test evidence. The only remaining parent gate was a green full desktop suite; that gate is deferred for this closure. The recorded result remains 590 passed, 3 skipped and 1 failure in `workflowModelTiers.spec.ts`; the suite is not green and the failure remains unresolved. No E2E rerun or new manual UI verification was performed for this status update.
