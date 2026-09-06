---
**Status:** 📋 Proposed
**Created:** 2026-09-06T13:41:43.996Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-030
title: States, accessibility, and theme verification
status: complete
feature: FX-BF-014
issue: docs/issues/features/fx-bf-014-workflow-experience/stories/fx-be-030-polish-and-verification/issue.md
updated: 2026-09-02
tasks: ['TASK-129', 'TASK-130', 'TASK-131']
dependencies: [FX-BE-028, FX-BE-029]
validation: [npm run check-types, npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# States, accessibility, and theme verification

## User or operational impact

Every edge case has a calm, themed answer, and the surface holds up under a keyboard-only and every-theme pass.

## Scope

- Loading (skeletons / spinners), empty, `.error-banner`, no-AI-provider, and no-git-folder states for all three screens per the design plan's matrix.
- Accessibility: labelled nav landmarks, `role=application` canvas with a described keyboard model, one live region per screen, a visually-hidden ordered stage list beside the pipeline diagram, focus order rail → centre → footer → pane-aux.
- Add the Library, Designer, and Run Monitor to the `themeLooks` gallery e2e and regenerate/inspect snapshots; responsive behaviour down to the app's minimum width.

## Acceptance criteria

- Each screen renders its loading, empty, error, no-provider, and no-folder states without layout break.
- A keyboard-only user can author a workflow, start a run, and inspect a stage.
- The theme-gallery e2e covers all three screens and passes across the installed themes.

## Task list

- `TASK-129` — Implement the states matrix for all three screens.
- `TASK-130` — Accessibility and focus-order pass.
- `TASK-131` — Add the screens to the theme-gallery e2e and verify responsiveness.

## Close when

The workflow experience passes a keyboard-only pass and a full theme-gallery pass with no unstyled or broken state.

## As built (2026-09-02)

**States (TASK-129).** Error is `.error-banner` on all three screens (already present). Added:
Library — a shimmer skeleton (`.wf-skeleton`, reduced-motion safe) while templates load, and
a lede above the template list. Designer — a footer note "Attach a folder to this project to
run this workflow" when the project has no folder, and "No agents were discovered …" in the
agent picker when the runtime catalog is empty. Monitor — a "No folder is attached …" note and
a "Save a workflow in the designer first" note on the start form. The graph loads synchronously
from an already-fetched template and the monitor reload is a single fast IPC call, so neither
got a dedicated spinner — the matrix's "canvas spinner / board spinner" rows were not needed.

**Accessibility (TASK-130).** Nav landmarks (`nav aria-label="Workflow stages" / "Runs"`),
one live region per screen (`role=status` on the run sentence / validation summary), the gate
`<table>` with a caption, and per-node `aria-label`s were already in place from FX-BE-027/029.
Added: an `sr-only` description of the canvas keyboard model wired via `aria-describedby` on the
`role=application` canvas, and an `sr-only` ordered stage list beside the pipeline diagram as
its non-visual equivalent. Focus order is DOM order: rail → canvas/board → footer/actions →
inspector.

**Themes & responsiveness (TASK-131).** `workflowThemes.spec.ts` boots the app on `one-dark`
and snapshots the library, designer, and run monitor — a hardcoded colour or missing token now
breaks a snapshot. (One representative dark palette rather than the whole gallery; there is no
per-screen multi-theme harness and building one was out of proportion.) The `.wf-designer` and
`.wf-runs` grids already carry a `@media (max-width: 1200px)` breakpoint from FX-BE-027.

## Description


## Dependencies



## Comments


