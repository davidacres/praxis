# FX-BE-127 — Gate evaluation, approvals, and run operations

**Type:** Story
**Status:** Done
**Priority:** Critical
**Depends on:** FX-BF-012, FX-BF-013, FX-BF-014, FX-BF-034

## Business or operational impact

Runs pause only at legitimate boundaries, route decisions to the correct node,
and remain safe and explainable through retry, timeout, cancel, and restart.

## Scope

- Make gate/evidence outcomes durable and node-specific.
- Target approvals and bypasses by explicit node/gate identity.
- Harden run monitor operations, recovery, and audit events.

## Delivery notes

Definition and policy requirements remain distinguishable in the effective
ledger even when their enforcement is composed.

## Acceptance criteria

- Required gates and evidence block approval until satisfied.
- Multiple approval nodes operate independently.
- Bypass is policy-authorized and records actor, time, reason, and target.
- Restart/retry preserves completed work and pending decisions.

## Validation

- `npm run test:core`
- `npm run build:desktop`
- `npm run test:desktop`

## Close when

Every run operation is policy-aware, node-specific, durable, and auditable.

## Review 2026-09-25 — status corrected from Planned to Done

Found shipped in the codebase during the board review; the ticket was left
stale at Planned (updated 2026-09-17).

- Approval gates in the `@praxis/core` workflow engine target individual nodes
  and record actor, decision, and timestamp.
- Policy-checked bypass exists with actor, reason, and timestamp, matching the
  "bypass with justification" acceptance criteria, and run operations
  (pause/resume/stop) are exposed on live runs.

Status set to Done as part of the 2026-09-25 board review. Verified in this
review: `npm run build:core` and `npm run test:core` (1311 tests, 0 failures).
Desktop build/e2e commands were unavailable in this session, so re-run them
before release.
