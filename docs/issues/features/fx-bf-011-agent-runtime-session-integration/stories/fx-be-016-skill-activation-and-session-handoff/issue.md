# FX-BE-016 — Skill activation and session handoff

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-015

## Business or operational impact

Users can move from selecting an agent and skill into correctly attributed work.

## Scope

- Activate skills using negotiated host capability mode.
- Launch and link sessions with agent and skill context.

## Acceptance criteria

- Untrusted and invalid skills cannot activate.
- Sessions retain context and remain the canonical history surface.

## Validation

- `npm run check-types`
- Focused Agent Hub and Sessions Playwright tests

## Close when

Agent Hub selection launches a correctly attributed session.
