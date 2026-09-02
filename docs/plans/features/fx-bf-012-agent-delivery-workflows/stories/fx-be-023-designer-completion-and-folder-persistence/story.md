---
id: FX-BE-023
title: Designer completion and folder persistence
status: complete
feature: FX-BF-012
issue: docs/issues/features/fx-bf-012-agent-delivery-workflows/stories/fx-be-023-designer-completion-and-folder-persistence/issue.md
updated: 2026-09-02
tasks: [TASK-107, TASK-108, TASK-109, TASK-110]
dependencies: [FX-BE-021]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# Designer completion and folder persistence

## User or operational impact

The workflow designer becomes shareable and legible: a project's workflows live
in its repo, agent stages are configured against the real Agent Hub catalog
instead of a free-text id, and a large graph can be read and rearranged on a
canvas.

## Scope

- Persist project-scoped definitions to `<projectFolder>/.praxis/workflows/*.json`
  so they are version-controlled and shareable; keep the app-local draft store
  as a fallback for folderless projects and unsaved-edit crash safety.
- Replace the raw agent-id field with a picker sourced from
  `agentRuntime.list()` that shows trust, capabilities, and skills, and surface
  the effective (composed) policy on approval stages.
- Add a pan/zoom canvas with draggable nodes and connection handles, reusing the
  Task Designer renderer helpers, while keeping workflow state and types
  separate from the ticket graph.
- Run the full packaged desktop suite and add designer + run-monitor visual
  snapshots.

## Acceptance criteria

- Saving a workflow in a folder-backed project writes a pretty-printed, path-safe
  JSON file under `.praxis/workflows`, and reloading reads it back without loss;
  a folderless project still round-trips through the draft store.
- The agent picker lists only discovered agents, shows each one's trust and
  capability state, and prevents selecting one that fails preflight; approval
  stages display any gate the composed policy adds and whether bypass is allowed.
- Canvas nodes can be added, configured, connected, moved, duplicated, and
  removed; invalid graphs and policy violations are surfaced before save or run;
  focus order, labels, and keyboard edge creation are covered by tests.
- `npm run test:desktop` passes with regenerated snapshots inspected.

## Task list

- `TASK-107` — Run the full desktop suite and add designer/monitor visual snapshots.
- `TASK-108` — Persist project workflows to `.praxis/workflows` with path safety and reload.
- `TASK-109` — Add the Agent Hub picker and effective-policy display to the inspector.
- `TASK-110` — Add the pan/zoom workflow canvas with draggable nodes and edges.

## Close when

A folder-backed project's workflow is authored on the canvas against real
agents, committed to `.praxis/workflows`, and reloaded intact, with the desktop
suite green.
