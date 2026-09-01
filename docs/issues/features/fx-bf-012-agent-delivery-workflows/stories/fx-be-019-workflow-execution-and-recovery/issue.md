# FX-BE-019 — Workflow execution, persistence, and recovery

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-018, FX-BF-011

## Business or operational impact
Long-running delivery runs must survive failures and restarts without losing progress or duplicating work.

## Scope
- Persist run/node transitions, artifacts, attempts, and audit history.
- Schedule safe fan-out/joins and enforce retry, timeout, cancellation, and recovery.

## Acceptance criteria
- Completed nodes are not rerun automatically after restart.
- Required failures block downstream stages and are visible.

## Validation
- `npm run build:core`
- `npm run test:core`

## Close when
Core and Electron execution tests prove deterministic recovery and bounded retries.
