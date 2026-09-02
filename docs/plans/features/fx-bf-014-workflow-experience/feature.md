---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-014
slug: workflow-experience
title: Workflow experience — native UI for the designer and run monitor
status: complete
owner: Electron desktop app
updated: 2026-09-02
issues: docs/issues/features/fx-bf-014-workflow-experience/feature-issues.md
stories: [FX-BE-027, FX-BE-028, FX-BE-029, FX-BE-030]
design: docs/plans/workflow-experience-design.md
validation: [npm run check-types, npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# FX-BF-014: Workflow experience

## Outcome

The governed delivery workflow surface reads as a native part of Praxis:
authoring and operating are two calm screens, the three-pane shell carries the
navigation and inspectors, every surface is token-driven and composes with
themes and surface packs, and no screen asks the user to hold too much at once.

## Scope

- Route workflow inspector/detail content into the shell's `pane-aux`; segmented
  `Design ⇄ Runs` header; a non-terminal run count badge on the sidebar row.
- All workflow styling moves to `theme.css` under a `wf-` prefix with per-kind
  accent tokens in every theme block; inline styles removed from the three
  current components.
- Library as a card grid + template list with per-node readiness.
- Designer as a docked stage rail + `.designer-canvas` hero + sticky footer,
  with the stage/edge inspector in `pane-aux` and a real agent picker.
- Run Monitor as a status board — sentence, read-only pipeline diagram, gate
  ledger table, collapsible timeline — with stage evidence in `pane-aux`.
- Full loading / empty / error / no-provider / no-folder states; accessibility
  pass; workflow screens added to the theme-gallery e2e.

## Story map

- `FX-BE-027` — Shell integration and theming foundation.
- `FX-BE-028` — Workflow Library and Designer.
- `FX-BE-029` — Run Monitor.
- `FX-BE-030` — States, accessibility, and theme verification.

## Dependencies

- `FX-BF-012` / `FX-BF-013` — the engine, designer state, orchestrator, and run
  monitor view model are built; this replaces their placeholder UI only.

## Close when

A user authors a workflow on the canvas against real agents, runs it, and reads
its progress — each in a distinct, themed, uncluttered screen that survives a
theme switch and a keyboard-only pass.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments
