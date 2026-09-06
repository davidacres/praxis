---
**Status:** 📋 Proposed
**Created:** 2026-08-27T21:20:02.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-007
title: Atlas spatial shell and continuous zoom vertical slice
status: proposed
feature: FX-BF-006
updated: 2026-08-27
tasks: [TASK-053, TASK-054, TASK-055, TASK-056, TASK-057, TASK-058, TASK-059]
dependencies: [FX-BF-005]
validation:
  - npm run frontend:build
  - npm run electron:check-types
  - npm run electron:copy-renderer
  - npm run test:e2e --workspace @praxis/desktop-main -- e2e/atlas.spec.ts
---

# Atlas spatial shell and continuous zoom vertical slice

## Atlas spatial shell and continuous zoom vertical slice

Parent feature folder: `fx-bf-006-atlas-spatial-workspace`

## User or operational impact

A person can open Atlas, see every project as a body in one space, fly inward
through a project to a board to a task to a running AI session, and see at a
glance which work is live, which is blocked, and which is ready — then drop back
to the board in one action.

## Scope

- Serializable Atlas snapshot and deterministic orbital layout in `packages/core`.
- A WebGL `AtlasPage` with four LOD tiers, a semantic-zoom camera, and a starfield.
- Node visual encoding with no colour-only signals, raycast selection into the
  existing detail surfaces.
- A live activity pass overlaid at every tier, including the
  session-awaiting-approval signal.
- Route, sidebar entry, deep links, and one-key exit to the board or list.

## Acceptance criteria

- Atlas opens from the sidebar into the universe tier showing one body per
  project.
- Double-clicking a body flies the camera inward to the next tier along an eased
  path; a breadcrumb and back action return outward.
- At the board tier, epics, stories, and tasks are arranged on stable orbits that
  do not overlap and do not change between runs for the same data.
- A blocked task is visibly tethered to its blocker; a ready-to-start task
  carries a halo; issue type, status, and recency are each readable without
  relying on colour alone.
- A running AI session shows motion and heat; a session waiting on user approval
  is visible as a distinct signal from the universe tier.
- Selecting any body opens the existing issue detail or session view as a DOM
  overlay while the scene keeps rendering.
- A deep link to a project, board, issue, or session opens Atlas focused on that
  body; back/forward history behaves like the rest of the app.
- One key returns to the board or list for the current context.
- Under `prefers-reduced-motion` the camera does not drift, bodies do not
  idle-spin, and transitions are instant.
- `npm run frontend:build`, `npm run electron:check-types`, and
  `npm run electron:copy-renderer` pass; the Atlas Electron spec passes.

## Task list

- `TASK-053` — Renderer stack spike and visual contract gate.
- `TASK-054` — Atlas snapshot model and builder in core.
- `TASK-055` — Deterministic orbital layout solver in core.
- `TASK-056` — Atlas scene, LOD tiers, and semantic-zoom camera.
- `TASK-057` — Node visual encoding and raycast selection into detail surfaces.
- `TASK-058` — Live activity pass and the awaiting-approval signal.
- `TASK-059` — Navigation integration, deep links, and vertical-slice verification.

## Notes

Layout stays pure and slow; activity is a separate fast pass and never mutates
layout. Reuse `IssueDetail` and the session view unchanged for detail — Atlas
contributes the scene, not new detail UI. Do not add a new privileged
main-process capability; consume the IPC that projects, boards, issues, and
sessions already expose plus a live subscription.

## Close when

A person can fly universe → project → board → task → session on the test fixture,
the three target questions are answerable faster than on the board, and the
read-only scene is stable, exitable, and reduced-motion safe in the packaged app.

## Description


## Dependencies



## Comments


