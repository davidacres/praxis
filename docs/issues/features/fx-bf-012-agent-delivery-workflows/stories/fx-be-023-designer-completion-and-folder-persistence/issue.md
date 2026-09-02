# FX-BE-023 — Designer completion and folder persistence

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-021

## Business or operational impact
A project's workflows must be shareable and version-controlled, configured
against the real Agent Hub catalog, and legible as a graph.

## Scope
- Write project-scoped definitions to `.praxis/workflows/*.json`; keep the draft
  store as a fallback.
- Agent Hub picker with trust/capability/skill display; effective-policy display
  on approval stages.
- Pan/zoom canvas with draggable nodes and connection handles.
- Full desktop suite run plus designer/monitor visual snapshots.

## Acceptance criteria
- A folder-backed project's workflow round-trips through a path-safe JSON file;
  a folderless project round-trips through the draft store.
- The picker lists only discovered agents, shows trust and capabilities, and
  blocks an agent that fails preflight; approval stages show composed-policy
  gates and bypass permission.
- Canvas nodes can be added, configured, connected, moved, duplicated, and
  removed; invalid graphs are surfaced before save; keyboard paths are tested.
- `npm run test:desktop` passes with snapshots inspected.

## Validation
- `npm run build`
- `npm run test:core`
- `npm run test:desktop`

## Close when
A workflow is authored on the canvas against real agents, committed to
`.praxis/workflows`, and reloaded intact, with the desktop suite green.
