# FX-BE-026 — Live updates, timeouts, and end-to-end verification

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-024, FX-BE-025

## Business or operational impact
The run monitor must track a background run as it moves, hung stages must be
bounded, and the whole pipeline must be verified without manual stage clicks.

## Scope
- `workflows:runChanged` push channel and monitor subscription.
- Timeout tick over running stages (`findTimedOutNodes`).
- Packaged desktop E2E of an unattended run with a stub agent, plus doc update.

## Acceptance criteria
- A background stage completion updates the monitor with no user action.
- A stage past its timeout fails with a clear reason and is offered for retry.
- The E2E completes an unattended run to approval, blocks on a failed required
  gate with evidence, recovers after a restart without re-running completed
  stages, and cancels cleanly.
- `docs/governed-delivery-workflows.md` describes real execution.

## Validation
- `npm run build`
- `npm run test:core`
- `npm run test:desktop`

## Close when
The built-in Governed delivery workflow runs from task to approval unattended in
a packaged desktop test, with the monitor live throughout.
