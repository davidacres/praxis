# FX-BE-126 — Workflow Designer and Task Designer integration

**Type:** Story
**Status:** Planned
**Priority:** High
**Depends on:** FX-BF-012, FX-BF-014, FX-BF-015, FX-BF-017

## Business or operational impact

Authoring and planning surfaces have an explicit, understandable handoff into
the same governed run model.

## Scope

- Share runtime readiness with Workflow Designer.
- Explicitly promote/use Task Designer plans as workflow inputs.
- Link task, workflow, controller session, run, stage, and evidence surfaces.

## Delivery notes

Task Designer remains a planning canvas; promotion must show mappings and keep
the original plan artifact intact.

## Acceptance criteria

- Designer readiness matches runtime preflight.
- Runs from either designer appear in the same monitor and session history.
- Stale, invalid, unavailable, and policy-blocked states are explained.

## Validation

- `npm run build:renderer`
- `npm run build:desktop`
- `npm run test:desktop`

## Close when

Both designers feed governed execution by explicit user intent and durable
provenance.
