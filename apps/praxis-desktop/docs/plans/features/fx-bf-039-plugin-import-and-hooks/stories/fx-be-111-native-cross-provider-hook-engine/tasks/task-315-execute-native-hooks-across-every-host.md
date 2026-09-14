---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-315
title: "Execute native hooks against every runtime host's session pipeline"
status: Proposed
story: FX-BE-111
feature: FX-BF-039
updated: 2026-09-14
dependencies: [TASK-314]
---

# TASK-315: Execute native hooks against every runtime host's session pipeline

## Objective

Wire TASK-314's hook engine into the session/tool event pipeline shared by every
runtime host (ACP, Copilot SDK, and direct API), so a hook fires from one place
regardless of which host produced the underlying event.

## Implementation notes

- Fire hooks from the point events already converge for every host — the session
  manager's own event append path (`aiSessionManager.ts` and its per-host adapters),
  not inside each host adapter separately, or drift between hosts is guaranteed.
- A hook script runs with the same sandboxing/permission boundary a local tool call
  already goes through — no new, wider trust surface. A hook is not exempt from the
  workflow policy's `requireTrustedAgents`-style gating; see FX-BE-114.
- A hook that throws, times out, or exceeds a resource budget fails closed for that
  one firing — it is recorded as a failed hook event on the session, and the
  session continues rather than the host process crashing.
- Ordering: hooks for the same event fire in a stable, documented order (declaration
  order within a plugin, then plugin install order) so two hooks that both match one
  event don't race.

## Acceptance criteria

- Identical hook firing/payload across all four provider categories, proven by test.
- A failing hook is visible in the session's event log, never a silent no-op or a
  crash.
- Hook execution never exceeds the trust/permission boundary of the session it
  fires within.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:core` for the cross-host firing tests and `npm run test:desktop`
for the end-to-end hook-fires-mid-session journey.

## Description


## Dependencies



## Comments
