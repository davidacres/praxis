# FX-BE-012 — Create Agent wizard and starter scaffold

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-010

## Business or operational impact

Users can create an agent without hand-authoring an invalid manifest or runtime layout.

## Scope

- Guided scope, identity, transport, entry, activation, and skill selection.
- Validated `agent.json` and transport starter files.

## Acceptance criteria

- Invalid ids, entries, duplicates, and unsafe paths are rejected.
- Output is discoverable in the selected scope after refresh.

## Validation

- `npm run test:core`
- Focused desktop creation tests

## Close when

A new agent can be created, inspected, and safely left unstarted.
