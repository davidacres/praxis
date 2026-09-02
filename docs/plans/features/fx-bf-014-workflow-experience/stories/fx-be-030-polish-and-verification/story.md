---
id: FX-BE-030
title: States, accessibility, and theme verification
status: proposed
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
