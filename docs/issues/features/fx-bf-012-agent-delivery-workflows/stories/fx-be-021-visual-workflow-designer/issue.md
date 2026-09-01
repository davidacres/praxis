# FX-BE-021 — Visual workflow designer and template library

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-018, FX-BF-009, FX-BF-005

## Business or operational impact
Users need to customize safe delivery workflows visually without hand-authoring executable configuration.

## Scope
- Add project/global template selection and a project-level workflow canvas.
- Configure agent, check, approval, and join nodes using scoped Agent Hub data.

## Acceptance criteria
- Invalid graphs and policy violations are blocked before save/run.
- Workflow scope, trust, capabilities, and project switching are clear.

## Validation
- `npm run build:renderer`
- `npm run build:desktop`
- `npm run test:desktop`

## Close when
A valid workflow can be visually configured and persisted to the intended scope.
