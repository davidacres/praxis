---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.728Z
**Type:** Task
**Priority:** Medium
id: TASK-337
title: Persist and navigate controller, stage, run, and node attribution
status: Planned
story: FX-BE-123
updated: 2026-09-17
dependencies: [TASK-335, TASK-336]
validation: [npm run test:core, npm run test:desktop]
---

# Persist and navigate controller, stage, run, and node attribution

## Goal

Make the relationship between a controller session, its run, and each stage
session visible from session history, the Run Monitor, and stage detail.

## Done when

- Session inspector shows workflow/run/node links and definition snapshot
  identity without exposing transport secrets.
- Run Monitor links to the controller session and each stage session; sessions
  link back to the exact run/node.
- Live updates and reopened history preserve the same chronological
  relationship.

## Notes

Reuse the existing shell navigation and session event history; do not create a
second persistence path owned only by the renderer.

## Description


## Dependencies



## Comments
