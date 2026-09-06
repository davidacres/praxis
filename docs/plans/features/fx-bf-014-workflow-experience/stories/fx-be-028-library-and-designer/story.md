---
type: Story
id: FX-BE-028
title: Workflow Library and Designer
status: complete
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

## As built (2026-09-02)

- The inspector lives in a **third column the Workflows feature owns** (`.wf-designer` is a
  `248px | 1fr | 340px` grid), not the global `pane-aux` — the Git Graph precedent, and
  `App.showAux` excludes `feature === 'workflows'`. Same visual result, no contention with
  the shell's resizable aux pane.
- That column is a **tabbed panel** (`Stage` / `Connections`) over one scrolling body, so
  neither a tall agent-stage form nor a long edge list overflows 340px. Selecting a node
  (rail or canvas) switches to the `Stage` tab. Edge rows are two lines — `from → to`, then
  the outcome select + `required` + an `×` icon button — and the add-form is a 2-col grid.
- Agent-stage warnings (no catalog / not discovered / would-fail-preflight) collapsed from
  stacked `role="status"` paragraphs to a single `⚠` glyph on the Agent field
  (`.wf-field-warn`, outside the `<label>` so the field's accessible name is unchanged) with
  the full text in its tooltip / `aria-label`.
- The footer `Run ▸` popover was replaced by a header `Design / Runs` segmented control
  (`.wf-viewswitch`) plus the start form in the Runs monitor; `route.workflowView` persists
  the half. Save is still gated on `valid && !unsaved`.
- Library uses `.wf-card` / `.wf-template` (self-contained bordered surfaces — there is no
  global `.card` class) with a `chip chip-muted` source tag and an amber `.wf-template-warn`
  readiness line.
- All workflow styling is token-driven under the `wf-` prefix in `theme.css`; the only
  remaining inline `style` is dynamic canvas geometry (transforms, node x/y).
- The non-terminal run-count badge (TASK-122) is a live `.tree-badge` on the Sidebar
  Workflows row, refreshed on `workflows:runChanged`.

## As built — navigation revision (2026-09-03)

Reworked so the shell does the heavy lifting:

- **Workflows is a sidebar tree section**, not a centre screen. The row expands to the
  project's saved workflows plus a **Runs** child; a `+` opens `NewWorkflowDialog`
  (template picker → `workflows.instantiate` → open its designer). The centre-pane Library
  screen and the `Design / Runs` header switch are gone; `route.workflowId` /
  `route.workflowView: 'runs'` drive the centre.
- **The inspector moved to the shell's right pane.** `App` renders a `wf-aux-slot` in
  `pane-aux` for `feature === 'workflows'`; `WorkflowDesignerPage` and `WorkflowRunMonitor`
  `createPortal` their Stage/Connections tabs (and the run-stage detail) into it. The
  designer grid is now two columns (rail + canvas); selecting a node calls `onRequireAux`
  so the pane reveals itself. `App.showAux` no longer excludes workflows.
- `WorkflowDesignerPage` now loads exactly one workflow by id (`workflows.get`) and carries
  a Delete action; it no longer owns template/library state.
