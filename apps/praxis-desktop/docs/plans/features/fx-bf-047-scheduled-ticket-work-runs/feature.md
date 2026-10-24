---
**Status:** 🔄 In Progress
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
type: Feature
id: FX-BF-047
slug: scheduled-ticket-work-runs
title: Scheduled ticket work runs with ordered execution
status: In Progress
owner: Electron desktop app
updated: 2026-10-20
stories: [FX-BE-147, FX-BE-148, FX-BE-149, FX-BE-173]
validation: [npm run check-types, npm run build:core, npm run build:renderer, npm run build:desktop, npm run test:core, npm run test:desktop]
---

# FX-BF-047: Scheduled ticket work runs with ordered execution

## Outcome

A user can create a scheduled work run that starts at a specific time, includes
multiple tickets, and preserves an explicit running order. The default execution
model is sequential so each ticket has a fair chance to finish before the next
one begins, with budget and approval gates visible before and during the run.

## Recommendation

Ship sequential execution first. It is the safer default because it protects
budget, keeps failure recovery easy to understand, and produces finished work
instead of starting several expensive sessions that may all stop mid-flight.

Allow parallel operation only as an explicit advanced option after the
sequential path is proven. Parallelism should be bounded, budget-aware, and
dependency-aware: the user chooses a small max concurrency, Praxis explains the
estimated spend, and the runner pauses before launching more work when the
remaining budget cannot reasonably complete the next ticket.

## Decisions (2026-10-20)

Recorded after design review. The v2 "processor and belt" mockups are the chosen
direction (`.praxis/session-artifacts/scheduled-runs-v2/`: compose, lineup, live
run, run report; animated MP4s plus stills).

1. **App closed at start time — ask on reopen.** A schedule whose start passed
   while Praxis was closed shows as *Missed* and the user chooses *Start now* or
   *Skip*. Praxis never silently starts a missed run. **Closing the app while a
   future schedule exists warns the user and recommends minimising (keeping
   Praxis running) instead**, because a closed app cannot start anything.
2. **One-off schedules only in the initial release.** No daily or weekday
   repeats. The contract keeps a single absolute `scheduledStartAt` so repeat
   rules can be added later without a migration.
3. **Budget is provider-aware, not a dollar cap.** The runner reads the usage
   and allowance of the enabled providers. When the active provider reaches
   **95%** of its allowance it records the current status (handover brief),
   commits a checkpoint, then switches to the next usable provider and hands the
   ticket over using the existing provider-handover and fallback machinery. If
   no enabled provider has headroom, the run pauses and asks; it never carries on
   past an allowance silently.
4. **Entry points follow the mockups.** A *Schedule run* button and a selection
   bar on the board, plus a *Scheduled runs* page in the navigation. Scheduling
   applies to board tickets only, never to a session that is already running.

## Runner decisions (2026-10-23)

Made while building FX-BE-148 and FX-BE-173; the sequential path is built, parallel
lanes (FX-BE-149) are not.

1. **One workflow per schedule.** `policy.workflowId`, chosen in the composer (default:
   a ticket-owned project workflow, else the governed-delivery template). Readiness
   blocks a schedule with none, or whose workflow needs workspace trust that has not
   been given — an unattended start cannot ask. Nothing falls back silently.
2. **Unattended launch options are fixed.** `providerLimitPolicy: 'switch'`, provider
   from the budget gate, no controller session, and `uncommittedChanges` left unset: a
   dirty base pauses the schedule instead of choosing "include" on the user's behalf.
3. **A failure pauses the run.** The user retries, skips or stops; the run never moves
   past a failed ticket by itself.
4. **Unknown allowance is never a destination.** A provider that reports no usage may
   be the one a run is already on (flagged "not checked"), but work is only handed to
   a provider with a known allowance under 95%. With none, the run pauses (`budget`).
5. **Hand-over takes effect at the next stage.** At 95% the run records the provider
   switch and a checkpoint commit in the worktree, and sets the workflow run's provider
   for stages not yet started. A turn in flight is never cut off.
6. **No double launch.** The entry is saved as running with a `launchToken` before the
   workflow is launched; the token is carried on the workflow run
   (`scheduledLaunchToken`). After a crash the run is found by token, otherwise the
   schedule pauses (`launch-interrupted`) and asks.
7. **Warning on close.** On Windows and Linux closing the last window quits, so the
   window guard warns; on macOS only a quit (Cmd+Q) stops the runner, so the quit
   guard warns. Choices: Minimise, Quit anyway, Cancel.
8. **The preview stays off by default.** The runner checks `preview.enableScheduledRuns`
   on every tick. Turning it on by default is a release decision after real overnight use.

## Scope

- Create a scheduled work-run model with start time, timezone, ticket list,
  explicit sequence numbers, run policy, budget guardrails, and audit history.
- Add a compact scheduling surface that lets a user pick tickets, drag or move
  them into a sequential order, and review readiness before saving the schedule.
- Execute scheduled runs through the existing session/workflow machinery instead
  of inventing a second automation engine.
- Make ticket status, session links, artifacts, approvals, failures, retries,
  and skipped work visible from the scheduled run.
- Add optional bounded parallel lanes only when tickets are independent and the
  user has opted into concurrency with an explicit max-lane and budget policy.

## Non-goals

- Do not make every scheduled run parallel by default.
- Do not bypass workflow gates, approval policy, trust checks, or provider
  allowance limits just because the run starts unattended.
- Do not treat a scheduled run as a calendar replacement; the feature schedules
  Praxis work, not meetings or external reminders.
- No repeating schedules (daily, weekdays) in the initial release.
- Do not schedule an existing session; only board tickets can be queued.

## Story map

- `FX-BE-147` — Scheduled work batch and ordered ticket queue.
- `FX-BE-148` — Budget-aware sequential runner and audit trail.
- `FX-BE-149` — Optional bounded parallel lanes.
- `FX-BE-173` — Processor run view, lineup and run report.

## Dependencies

- `FX-BF-035` — multi-AI session orchestration and runtime boundaries.
- `FX-BF-040` — connected workflow sessions and governed delivery.
- `FX-BF-041` — session usage, cost, and provider allowance visibility.
- `FX-BF-036` — interactive response surfaces for schedule approvals and
  confirmations.

## Design notes

- Store `scheduledStartAt` as an absolute timestamp plus the user's timezone for
  display and rescheduling.
- Store ticket order as stable queue entries rather than deriving it from board
  column order.
- Prefer one active ticket by default. A schedule may contain many tickets, but
  the runner should complete, fail, skip, or pause each queue entry before
  launching the next sequential entry.
- Treat parallel lanes as a policy on a scheduled run, not as separate schedules.
  This lets the run ledger explain exactly why multiple tickets were active.
- Require explicit dependencies or independence checks before two tickets can
  run in parallel.

## Risks or open questions

Resolved 2026-10-20: missed-start behaviour, repeats, budget control and entry
point (see Decisions). Still open:

- Parallel runs can consume provider allowance quickly and leave no single
  ticket complete. This is why concurrency starts disabled and should be capped.
- Scheduled starts need clear timezone behavior across travel, daylight-saving
  changes, and app restarts.
- Unattended starts must not silently pass approvals. If a workflow reaches a
  gate, the run should pause and ask the user.
- A schedule that references a deleted or moved ticket should remain auditable
  and skip or block with a readable reason.

## Close when

A user can pick several tickets, set a start time, arrange the exact run order,
save the schedule, see it survive app restart, watch Praxis start it at the
right time, and review each queue entry's session, status, spend, artifacts,
and outcome. Sequential execution is the default. Optional parallel execution is
available only behind an explicit capped policy with clear budget warnings and
run-ledger evidence.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments




**PRX-F47** — 2026-10-18T20:50:47.528Z
**Workflow run cancelled: Governed delivery — Governed delivery 1**

Status: Cancelled · Duration: 116h 44m

- ✅ Plan: succeeded
- ❌ Implement: failed
- ⏭️ Praxis Test contracts: cancelled
- ⏭️ Review: cancelled
- ⏭️ Install dependencies: cancelled
- ⏭️ Build: cancelled
- ⏭️ QA: cancelled
- ⏭️ Security scan: cancelled

cancelled from the run view

**2026-10-20:** Plans updated from design review (see Decisions), then FX-BE-147 built: the core model, store, readiness and timezone rules; main IPC; and the composer and lineup in the renderer, behind `preview.enableScheduledRuns`. FX-BE-148 (the runner, the close-app warning, and the 95% provider hand-over) and FX-BE-173 (the processor run view and report) are not started. Do not enable the preview by default until the runner exists.


**PRX-F47** — 2026-10-22T19:19:00.008Z
Starting analysis of FX-BF-047: inspect all feature/story/task acceptance criteria, existing model/store/runner/IPC/UI and orchestration/usage/gadget dependency contracts; identify gaps and publish a file-level implementation plan before edits. Then implement only remaining scheduled-run scope and run the required compile, automated and visual verification gates.

**PRX-F47** — 2026-10-22T19:19:24.577Z
Kickoff blocked before code edits: tracker_transition_ticket(PRX-F47, In Progress) returned 'Transition In Progress not valid for PRX-F47'. The ticket is already presented as In Progress; available transitions omit In Progress. Initial analysis confirms schedule definition/store/readiness, composer/lineup and board integration exist, while scheduledRunIpc explicitly starts no work. Remaining feature scope includes timed sequential execution/recovery, provider allowance checks and checkpoint handover, close warning, bounded parallel safety, live controls and report. No implementation files changed and no tests run. Stopping in accordance with the supplied no-retry/no-improvised-lifecycle contract; no completion transition attempted.

**PRX-F47** — 2026-10-22T20:09:35.719Z
**Workflow run failed: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Failed · Duration: 51m 49s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-F47** — 2026-10-22T20:09:52.747Z
**Workflow run failed: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Failed · Duration: 52m 6s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-F47** — 2026-10-22T20:10:13.813Z
**Workflow run failed: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Failed · Duration: 52m 27s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-F47** — 2026-10-22T20:11:04.828Z
**Workflow run failed: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Failed · Duration: 53m 18s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-F47** — 2026-10-22T20:12:28.471Z
**Workflow run cancelled: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Cancelled · Duration: 54m 42s

- ✅ Plan: succeeded
- ⏭️ Implement: cancelled
- ⏭️ Praxis Test contracts: cancelled
- ⏭️ Review: cancelled
- ⏭️ Install dependencies: cancelled
- ⏭️ Build: cancelled
- ⏭️ QA: cancelled
- ⏭️ Security scan: cancelled

cancelled from the run view

**PRX-F47** — 2026-10-23T09:19:41.069Z
**Workflow run failed: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Failed · Duration: 2s

- ❌ Plan: failed
- ⏳ Implement: pending
- ⏳ Praxis Test contracts: pending
- ⏳ Review: pending
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "plan" failed.

**PRX-F47** — 2026-10-23T10:02:50.253Z
**Workflow run failed: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Failed · Duration: 29m 3s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-F47** — 2026-10-23T10:04:28.595Z
**Workflow run failed: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Failed · Duration: 30m 41s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-F47** — 2026-10-23T10:19:26.177Z
**Workflow run failed: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Failed · Duration: 45m 39s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-F47** — 2026-10-23T10:20:49.725Z
**Workflow run failed: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Failed · Duration: 13s

- ❌ Plan: failed
- ⏳ Implement: pending
- ⏳ Praxis Test contracts: pending
- ⏳ Review: pending
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "plan" failed.

**PRX-F47** — 2026-10-23T16:41:16.698Z
**Workflow run failed: Governed delivery — FX-BF-047: Scheduled ticket work runs with ordered execution**

Status: Failed · Duration: 6h 19m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ❌ QA: failed
- ✅ Security scan: succeeded

Required stage "qa" failed.