---
**Status:** 🚧 In progress
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-014
slug: workflow-experience
title: Workflow experience — native UI for the designer and run monitor
status: complete
owner: Electron desktop app
updated: 2026-09-03
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

## As built — navigation revision (2026-09-03)

The feature shipped centre-heavy; a follow-up moved it into the shell:

- **Workflows is a left-sidebar tree section.** The row expands to the project's saved
  workflows plus a **Runs** child; `+` opens `NewWorkflowDialog`. The Library screen and
  the in-header `Design / Runs` switch are gone. Routes: `route.workflowId` (designer for
  one workflow, loaded by `workflows.get`) and `route.workflowView: 'runs'` (monitor) —
  both persisted in the durable route.
- **The Stage / Connections inspector (and the run-stage detail) render in the shell's
  right pane** via `createPortal` into a `wf-aux-slot` that `App` puts in `pane-aux` for
  the Workflows feature. The designer grid is two columns (rail + canvas); selecting a
  node calls `onRequireAux` so the pane reveals itself. `App.showAux` no longer excludes
  workflows. This returns to FX-BE-028's original "inspector in pane-aux" intent.
- e2e for `workflowDesigner`, `workflowRun`, `workflowThemes`, and `appShell` were
  reworked to the sidebar flow; snapshots regenerated for the wider two-column centre and
  the right-pane inspector.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments
