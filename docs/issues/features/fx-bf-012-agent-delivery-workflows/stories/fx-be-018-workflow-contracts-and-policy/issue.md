# FX-BE-018 — Workflow definition, policy, and validation contracts

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BF-009, FX-BF-010, FX-BF-011

## Business or operational impact
Workflow authors need a safe, versioned contract that references trusted Agent Hub identities.

## Scope
- Define workflow nodes, typed edges, artifacts, policies, and storage precedence.
- Validate DAG structure, capabilities, permissions, and required gates before execution.

## Acceptance criteria
- Unsafe or malformed definitions fail closed with actionable paths.
- Global and project definitions never silently shadow each other.

## Validation
- `npm run build:core`
- `npm run test:core`

## Close when
Valid definitions round-trip and invalid definitions are rejected by core tests.
