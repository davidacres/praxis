# FX-BE-123 — Workflow selection and session/run linkage

**Type:** Story
**Status:** Planned
**Priority:** Critical
**Depends on:** FX-BF-012, FX-BF-013, FX-BF-014, FX-BF-038

## Business or operational impact

Users can choose a governed workflow from a session and see the controller
session, run, stage sessions, and node relationships as one durable history.

## Scope

- Add workflow selection and readiness to session entry points.
- Create an immutable run snapshot and link it to the originating session.
- Persist and navigate controller, stage, run, and node attribution.

## Delivery notes

The session is the entry/control surface; the orchestrator owns graph execution.

## Acceptance criteria

- Invalid definitions, bindings, skills, trust, folders, and policies block
  start with actionable reasons.
- Selection → run → stage links survive app restart and reopening.

## Validation

- `npm run test:core`
- `npm run build:desktop`
- `npm run test:desktop`

## Close when

A user can start a governed run from a session and navigate the durable
relationship in both session and run surfaces.
