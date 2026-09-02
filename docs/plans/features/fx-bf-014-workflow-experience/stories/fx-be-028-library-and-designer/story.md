---
id: FX-BE-028
title: Workflow Library and Designer
status: proposed
feature: FX-BF-014
issue: docs/issues/features/fx-bf-014-workflow-experience/stories/fx-be-028-library-and-designer/issue.md
updated: 2026-09-02
tasks: ['TASK-123', 'TASK-124', 'TASK-125']
dependencies: [FX-BE-027]
validation: [npm run check-types, npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# Workflow Library and Designer

## User or operational impact

Choosing a starting point is one click, and shaping a workflow is a calm canvas with an inspector, not a scrolling form.

## Scope

- Library: project workflows as a responsive `.card` grid with a single readiness line; templates as a bordered list with a `built-in` chip and `Use this`; empty state is the template list plus a one-line lede.
- Designer: a docked themed stage rail (the `.sessions-list` pattern), `.designer-canvas` as the centre hero with per-kind node accents and curved edges, and a sticky footer (validation chip + `Run ▸` popover + `Save`).
- Stage/edge inspector in `pane-aux`: agent picker with a trust dot, capability line, skill checkboxes with a drift flag, and a remediation link to Agent Hub for an unusable pick; policy-locked gate checkboxes on approval nodes.
- Edge midpoint pill on the canvas for outcome/required/delete; keyboard node nudge and select.

## Acceptance criteria

- A template instantiates a project copy in one click and opens the Designer.
- Adding, configuring, connecting, moving, duplicating, and removing stages works on the canvas and the rail interchangeably.
- The agent picker lists only discovered agents with their trust and capability state and blocks a pick that fails preflight.
- The footer `Run ▸` is disabled while the workflow is invalid or unsaved and navigates to Runs on start.

## Task list

- `TASK-123` — Build the Library card grid and template list with readiness.
- `TASK-124` — Build the Designer: docked stage rail, canvas hero, sticky footer.
- `TASK-125` — Move the inspector to pane-aux with the agent picker and policy display.

## Close when

A workflow is authored on the canvas against real agents and saved, with the inspector in the shell's right pane.
