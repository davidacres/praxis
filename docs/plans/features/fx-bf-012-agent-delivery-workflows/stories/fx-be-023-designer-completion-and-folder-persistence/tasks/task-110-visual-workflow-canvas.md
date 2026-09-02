---
**Status:** 📋 Proposed
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-110
title: Add the pan/zoom workflow canvas with draggable nodes and edges
status: proposed
story: FX-BE-023
updated: 2026-09-02
dependencies: [FX-BE-021]
validation: [npm run build:renderer, npm run build:desktop, npm run test:desktop]
---
## Add the pan/zoom workflow canvas with draggable nodes and edges
## Goal
Give the designer a spatial view: nodes as cards positioned by their stored
x/y, draggable, with connection handles, and edges rendered as curves carrying
the outcome and required affordances — the Task Designer interaction language,
applied to workflow state.
## Done when
- Nodes can be added, moved (drag, persisted x/y), duplicated, connected via
  handles, and removed on the canvas; the inspector side panel is unchanged.
- Edge curves show and let the user set `on` (success/failure/always) and
  `required`; a self-loop or duplicate edge is refused on the canvas as in the
  list editor.
- Live validation badges the offending node on the canvas; the structured list
  remains available as an alternative view.
- Workflow canvas state and types stay separate from `taskDesignerState`; only
  the pure renderer helpers (curve paths, anchor points, pointer-drag) are
  reused.
- Keyboard: nodes are focusable and reorderable, an edge can be created without
  a pointer, and the a11y path is covered by a desktop test.
## Notes
Reuse `taskDesigner`'s renderer helpers (`buildConnectorCurvePath`,
`anchorPoint`, pointer handlers). Do not import runtime values from
`@praxis/core` — extend `renderer/src/workflows/workflowEdits.ts` for any new
pure mutation.

## Description


## Dependencies



## Comments


