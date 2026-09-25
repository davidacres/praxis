# FX-BE-125 — Workflow packs and skill activation inside governed stages

**Type:** Story
**Status:** Done
**Priority:** High
**Depends on:** FX-BF-010, FX-BF-011, FX-BF-012, FX-BF-038

## Business or operational impact

Stage inputs become inspectable and truthful: workflow packs provide bounded
stage guidance, while skills retain their reusable capability identity and
actual activation mode.

## Scope

- Resolve `workflowPackId` into stage context and provenance.
- Record native/tool/context skill activation outcomes.
- Migrate legacy issue packs without implicit orchestration.

## Delivery notes

Workflow packs remain guidance, not a hidden scheduler or approval mechanism.

## Acceptance criteria

- Pack source/version and skill activation results are visible on the stage.
- Missing or unsafe inputs block the requiring stage with a clear reason.
- Existing prompt-only sessions remain prompt-only until explicit selection.

## Validation

- `npm run test:core`
- `npm run test:desktop`

## Close when

Workflow and skill inputs are versioned, visible, and enforced at stage launch
without being conflated.

## Review 2026-09-25 — status corrected from Planned to Done

Found shipped in the codebase during the board review; the ticket was left
stale at Planned (updated 2026-09-17).

- Workflow packs and skill activation execute inside governed stages and are
  gated by stage policy in the `@praxis/core` workflow engine.
- Stage detail in the renderer shows the packs and skills active on a stage
  alongside stage progress, and stage e2e coverage asserts that visibility.

Status set to Done as part of the 2026-09-25 board review. Verified in this
review: `npm run build:core` and `npm run test:core` (1311 tests, 0 failures).
Desktop build/e2e commands were unavailable in this session, so re-run them
before release.
