---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-317
title: "Build the hook management view"
status: Proposed
story: FX-BE-112
feature: FX-BF-039
updated: 2026-09-14
dependencies: [TASK-316]
---

# TASK-317: Build the hook management view

## Objective

Implement FX-BE-109/TASK-311's management-view design: one list of every active
hook — native or imported — with source, active host(s), last-fired time, drill-in
firing history, and an immediate enable/disable toggle.

## Implementation notes

- Native and imported/passthrough hooks (once FX-BE-113 lands) share this one list;
  do not split them into separate views the user has to remember to check both of —
  the design explicitly calls this out.
- Firing history reads from the hook-failure/hook-fired events TASK-315's engine
  already records on the session — this view is a presentation layer over existing
  data, not a second recording mechanism.
- The enable/disable toggle takes effect on the next matching event, not the next
  app restart — flip it and the change is live immediately.
- A hook that only works under Claude Code (per FX-BE-113's translation report)
  shows that status here too, in the same row a working hook would occupy, not a
  separate "unsupported" section that's easy to miss.

## Acceptance criteria

- One list covers every hook regardless of origin, matching the signed-off design.
- Firing history is accurate and reflects real engine events, not a mock.
- Enable/disable is immediate.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` for the management-view e2e coverage and
`npm run check-types` across workspaces.

## Description


## Dependencies



## Comments
