# FX-BE-022 — Run monitor, delivery template, and end-to-end verification

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-019, FX-BE-020, FX-BE-021

## Business or operational impact
Users need visible proof that a governed delivery pipeline ran correctly and why it is blocked or complete.

## Scope
- Ship Plan → Implement → Review/QA/Security → Approval.
- Add live run monitoring, evidence, approvals, retry/cancel, restart recovery, and documentation.

## Acceptance criteria
- Required branch failures block approval and expose evidence.
- Restart restores the monitor without duplicating completed work.

## Validation
- `npm run build`
- `npm run test:core`
- `npm run test:desktop`

## Close when
The built-in workflow completes through approval in packaged desktop E2E.
