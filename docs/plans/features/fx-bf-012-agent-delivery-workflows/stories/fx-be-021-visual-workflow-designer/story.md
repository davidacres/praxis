---
type: Story
id: FX-BE-021
title: Visual workflow designer and template library
status: complete
feature: FX-BF-012
issue: docs/issues/features/fx-bf-012-agent-delivery-workflows/stories/fx-be-021-visual-workflow-designer/issue.md
updated: 2026-09-02
tasks: [TASK-101, TASK-102, TASK-103]
dependencies: [FX-BE-018, FX-BF-009, FX-BF-005]
validation: [npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# Visual workflow designer and template library

## User or operational impact

Users can start from safe delivery templates and customize supported workflow stages without hand-authoring JSON.

## Scope

- Add project-level workflow library and template selection.
- Add a workflow canvas with agent, check, approval, and join nodes plus an inspector.
- Reuse Task Designer interaction patterns while keeping workflow state/types separate from ticket graphs.

## Acceptance criteria

- Agent and skill choices come from the scoped Agent Hub catalog and show trust/capability state.
- The editor prevents invalid graphs and surfaces policy violations before saving or running.
- Loading, saving, duplicating, and switching projects preserves the correct workflow scope.

## Task list

- `TASK-101` — Add workflow template library and project/global selection.
- `TASK-102` — Implement workflow canvas, node palette, edges, and node inspector.
- `TASK-103` — Add workflow persistence, validation feedback, and accessibility coverage.

## Close when

A user can visually configure a valid workflow using discovered agents and save it to the intended scope.
