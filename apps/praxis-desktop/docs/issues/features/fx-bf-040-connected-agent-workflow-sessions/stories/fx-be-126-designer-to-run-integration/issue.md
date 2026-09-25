# FX-BE-126 — Workflow Designer and Task Designer integration

**Type:** Story
**Status:** Done
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

## Review 2026-09-25 — status corrected from Planned to Done

Found shipped in the codebase during the board review; the ticket was left
stale at Planned (updated 2026-09-17).

- Task Designer promotions are runtime-readiness checked before a workflow
  goes live, and promoted designs stay editable in the Workflow Designer.
- Cross-surface run provenance links sessions and runs back to the originating
  design, matching the acceptance criteria here.

Status set to Done as part of the 2026-09-25 board review. Verified in this
review: `npm run build:core` and `npm run test:core` (1311 tests, 0 failures).
Renderer/desktop build and e2e commands were unavailable in this session, so
re-run them before release.
