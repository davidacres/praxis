---
id: TASK-042
title: Three-way conflict resolution
status: complete
story: FX-BE-004
updated: 2026-08-27
dependencies: [TASK-038, TASK-041]
validation: [npm run test:git --workspace @praxis/desktop-main, apps/praxis-desktop/main/output/playwright/praxis-conflict-editor.png]
---

## Three-Way Conflict Resolution

## Goal

Resolve conflicts inside Praxis using current, incoming, and editable output panes with whole-side and individual-line choices.

## Done when

- Text and binary conflicts have deliberate resolution paths.
- Manual results reject unresolved markers, stage safely, and expose abort only when Git reports an abortable operation.
