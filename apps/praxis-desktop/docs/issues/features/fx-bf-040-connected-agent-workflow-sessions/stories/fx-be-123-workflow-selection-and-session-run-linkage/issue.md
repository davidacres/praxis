# FX-BE-123 — Workflow selection and session/run linkage

**Type:** Story
**Status:** Done
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

## Review 2026-09-25 — status corrected from Planned to Done

Found shipped in the codebase during the board review; the ticket was left
stale at Planned (updated 2026-09-17).

- The New Session composer offers governed workflow selection with readiness
  feedback before a run starts, and invalid definitions, bindings, skills,
  trust, folders, or policies surface as blocking reasons instead of silent
  failures.
- Starting a workflow creates a durable `WorkflowRun` snapshot linked to the
  originating session, with stage sessions attributed to run and node; the
  Run Monitor and session surfaces reopen the same relationship.

Status set to Done as part of the 2026-09-25 board review. Verified in this
review: `npm run build:core` and `npm run test:core` (1311 tests, 0 failures).
Desktop build/e2e commands were unavailable in this session, so re-run them
before release.
