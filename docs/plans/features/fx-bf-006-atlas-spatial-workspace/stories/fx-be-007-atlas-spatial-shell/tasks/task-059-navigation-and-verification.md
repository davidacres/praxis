---
**Status:** 📋 Proposed
**Created:** 2026-08-31T12:27:32.008Z
**Type:** Task
**Priority:** Medium
id: TASK-059
title: Atlas navigation integration and vertical-slice verification
status: proposed
story: FX-BE-007
updated: 2026-08-27
dependencies: [TASK-057, TASK-058]
validation:
  - npm run frontend:build
  - npm run electron:check-types
  - npm run electron:copy-renderer
  - npm run test:e2e --workspace @praxis/desktop-main -- e2e/atlas.spec.ts
---

## Atlas navigation integration and vertical-slice verification

## Goal

Add the `atlas` route and sidebar entry, keep back/forward history compatible
with the rest of the app, support deep links to a project, board, issue, or
session focus target, and add a one-key return to the board or list for the
current context. Then run the vertical-slice verification: an Electron visual and
performance pass on the fixture (about 4 projects, about 300 issues, several live
sessions), the reduced-motion path, and a documented check that "what is running
/ what is blocked / what is next" is answerable faster in Atlas than on the
board.

## Done when

- The Atlas Electron spec passes.
- Deep links and back/forward history behave like the rest of the app.
- Reduced motion is safe: no camera drift, no idle spin, instant transitions.
- The usability check and its result are recorded in the story file.

## Description


## Dependencies



## Comments


