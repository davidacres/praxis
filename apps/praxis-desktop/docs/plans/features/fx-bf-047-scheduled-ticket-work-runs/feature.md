---
**Status:** 📋 Proposed
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
type: Feature
id: FX-BF-047
slug: scheduled-ticket-work-runs
title: Scheduled ticket work runs with ordered execution
status: Backlog
owner: Electron desktop app
updated: 2026-09-29
stories: [FX-BE-147, FX-BE-148, FX-BE-149]
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

## Story map

- `FX-BE-147` — Scheduled work batch and ordered ticket queue.
- `FX-BE-148` — Budget-aware sequential runner and audit trail.
- `FX-BE-149` — Optional bounded parallel lanes.

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


