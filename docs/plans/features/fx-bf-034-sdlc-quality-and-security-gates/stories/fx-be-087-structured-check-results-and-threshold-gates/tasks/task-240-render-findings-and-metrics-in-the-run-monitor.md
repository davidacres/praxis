---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-240
title: "Render findings and metrics in the run monitor"
status: To Do
story: FX-BE-087
updated: 2026-09-09
dependencies: [TASK-238, TASK-239]
---

# TASK-240: Render findings and metrics in the run monitor

**Priority:** Medium
**Created:** 2026-09-09

## Goal

Show a node's `CheckFindings` in the stage detail panel: findings grouped by severity (critical → info), each row with file:line, category and message, expandable to the suggestion; named metrics as a small labelled set; a gate's threshold detail shows the actual-versus-bar value. Each finding links to its evidence entry. Reuse theme tokens, pane conventions and keyboard focus; no new colour token beyond the existing severity/status tones.

## Implementation entry points

apps/praxis-desktop/renderer/src/workflows (`WorkflowRunMonitor.tsx` and the stage detail panel), renderer types only from core. Reuse the evidence-link affordance TASK-134 added.

## Dependencies

- TASK-238
- TASK-239
## Acceptance criteria

- A stage with findings renders them grouped and counted by severity; a stage with none shows an explicit empty state, not a blank panel.
- A threshold gate row shows the metric/severity condition and the run's actual value; a blocked gate reads the same reason the engine produced.
- Verified across theme axes, a narrow layout and keyboard focus; captures inspected.
- The implementation satisfies the parent story's outcome and preserves existing unrelated run-monitor behaviour.

## Verification

Rebuild and copy the renderer; focused Electron specs for the run monitor with a seeded findings fixture; inspect captures across `data-mode`, a narrow width and tab focus. Prove the empty-state and grouping guards fail against a naive render. Update the feature-parity AI & agents rows. Never point a Praxis write path at the repository's own plans.

## Description


## Comments


