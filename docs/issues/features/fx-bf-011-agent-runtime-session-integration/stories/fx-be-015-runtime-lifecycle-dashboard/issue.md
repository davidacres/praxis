# FX-BE-015 — Runtime lifecycle dashboard

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-011

## Business or operational impact

Users can see and control trusted hosts from the Agent Hub.

## Scope

- Lifecycle status, capabilities, and errors.
- Safe start, stop, and restart through typed desktop boundaries.

## Acceptance criteria

- Invalid and untrusted agents cannot run.
- Stop disposes resources; restart disposes and recreates safely.

## Validation

- `npm run test:core`
- Focused desktop lifecycle tests

## Close when

Runtime state is accurate and discovery never spawns a host.
