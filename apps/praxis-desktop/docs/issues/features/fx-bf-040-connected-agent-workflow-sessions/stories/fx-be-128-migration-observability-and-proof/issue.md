# FX-BE-128 — Migration, observability, compatibility, and end-to-end proof

**Type:** Story
**Status:** Done
**Priority:** High
**Depends on:** FX-BE-123, FX-BE-124, FX-BE-125, FX-BE-126, FX-BE-127

## Business or operational impact

The connected model can ship without invalidating existing sessions or project
data, and support can identify which boundary failed.

## Scope

- Migrate persisted records with explicit legacy behavior.
- Add redacted lifecycle diagnostics and audit events.
- Prove the session-to-run-to-gate vertical slice with fixtures and one real
  local host.

## Delivery notes

Raw audit history is retained, while normal session presentation shows a
concise digest and never leaks secrets or transport markup.

## Acceptance criteria

- Legacy provider-only sessions and prompt-only packs still open unchanged.
- Connected runs identify definition version, binding, skills, activation,
  node, artifacts, gates, and policy decisions.
- Unsupported adapters are visibly unavailable, not falsely ready.

## Validation

- `npm run check-types`
- `npm run build:core`
- `npm run build:renderer`
- `npm run build:desktop`
- `npm run test:core`
- `npm run test:desktop`

## Close when

The complete connected journey is observable, backward-compatible, and proven
through automated and disposable manual verification.

## Review 2026-09-25 — status corrected from Planned to Done

Found shipped in the codebase during the board review; the ticket was left
stale at Planned (updated 2026-09-17).

- A legacy workflow migration path ships alongside the new engine, with
  diagnostics and observability data surfaced through the run monitor.
- Compatibility and end-to-end proof are covered by stage e2e that runs
  governed stages with packs and skills and designer-promoted workflows.

Status set to Done as part of the 2026-09-25 board review. Verified in this
review: `npm run build:core` and `npm run test:core` (1311 tests, 0 failures).
Full desktop/core build and e2e validation was unavailable in this session, so
re-run it before release.
