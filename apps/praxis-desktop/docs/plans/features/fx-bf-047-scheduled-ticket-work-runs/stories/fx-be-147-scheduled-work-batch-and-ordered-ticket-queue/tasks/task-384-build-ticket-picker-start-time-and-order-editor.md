---
**Status:** 📋 Proposed
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-384
title: Build ticket picker, start-time, and order editor
status: Backlog
story: FX-BE-147
updated: 2026-09-29
dependencies: [TASK-383]
validation: [npm run check-types, npm run build:renderer, npm run test:desktop]
---

# Build ticket picker, start-time, and order editor

## Goal

Add the user-facing schedule editor for selecting tickets, choosing the
scheduled start, and arranging the sequential running order.

## Done when

- The editor supports adding, removing, and reordering tickets with keyboard and
  pointer controls.
- The selected start time is shown with timezone context and validation.
- Readiness warnings appear before save when tickets, workflows, providers, or
  policies are not launchable.
- Reopening a saved schedule shows the same ordered queue.

## Notes

Keep the editor compact and operational. This is a work surface, not a landing
page.

