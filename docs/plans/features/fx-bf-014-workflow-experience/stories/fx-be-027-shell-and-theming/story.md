---
id: FX-BE-027
title: Shell integration and theming foundation
status: proposed
feature: FX-BF-014
issue: docs/issues/features/fx-bf-014-workflow-experience/stories/fx-be-027-shell-and-theming/issue.md
updated: 2026-09-02
tasks: ['TASK-120', 'TASK-121', 'TASK-122']
dependencies: [FX-BF-013]
validation: [npm run check-types, npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# Shell integration and theming foundation

## User or operational impact

The workflow surface uses the app's three-pane shell and its token system, so it themes and composes like every other feature.

## Scope

- Route `feature === 'workflows'` inspector/detail content into the shell's `pane-aux`; the page markup shrinks to left column + centre.
- Add a segmented `Design ⇄ Runs` header control (`.btn-compact`, `role=tablist`) and persist the choice in `route.workflowView`.
- Add `.wf-*` classes and `--wf-agent/-check/-approval/-join` accent tokens to `theme.css`, defined on `:root` first and in every `[data-theme]` / dark block; delete inline `style={{…}}` colour/spacing/radius from the three current components.
- Show a non-terminal run count badge on the `Workflows` sidebar row via `featureCounts`.

## Acceptance criteria

- The stage/edge inspector and run-stage detail render in `pane-aux`, resize with it, and its width persists.
- Switching theme, mode, accent, and surface pack restyles every workflow screen with no hard-coded colour left.
- The sidebar `Workflows` row shows a count while any run is `running` or `awaiting-approval`.

## Task list

- `TASK-120` — Route workflow detail into pane-aux and add the Design/Runs header control.
- `TASK-121` — Add wf- classes and kind-accent tokens across every theme block; remove inline styles.
- `TASK-122` — Add the non-terminal run count badge to the sidebar row and the workflowView route field.

## Close when

Every workflow screen renders through the shell and the token system, verified by a theme-switch pass.
