# FX-BE-127 — Gate evaluation, approvals, and run operations

**Type:** Story
**Status:** Planned
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
