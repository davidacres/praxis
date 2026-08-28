---
id: TASK-040
title: WIP and granular change actions
status: complete
story: FX-BE-004
updated: 2026-08-27
dependencies: [TASK-038, TASK-039]
validation: [npm run test:git --workspace @praxis/desktop-main, apps/praxis-desktop/main/e2e/gitGraph.spec.ts]
---

## WIP And Granular Change Actions

## Goal

Make working changes part of the graph story and support file, hunk, and selected-line stage/unstage/discard actions.

## Done when

- WIP, staged, unstaged, untracked, and conflicted files are explicit.
- Destructive actions require scoped confirmation and untracked files are never silently deleted.
