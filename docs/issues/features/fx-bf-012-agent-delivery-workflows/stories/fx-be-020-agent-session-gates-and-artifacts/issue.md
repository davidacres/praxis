# FX-BE-020 — Agent session stages, gates, artifacts, and approvals

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-018, FX-BE-019, FX-BF-009, FX-BF-011

## Business or operational impact
Every delivery stage must run through trusted runtime boundaries and produce inspectable evidence.

## Scope
- Bind stages to Agent Hub agents, skills, capabilities, workspaces, and tool modes.
- Attribute sessions and typed artifacts; enforce deterministic checks and approvals.

## Acceptance criteria
- Untrusted or incompatible stages cannot start.
- Required review, QA, and security gates block approval until evidence passes.
- Optional bypasses record user, time, and reason.

## Validation
- `npm run build:desktop`
- `npm run test:core`
- `npm run test:desktop`

## Close when
Run history links every stage to its agent session, artifacts, evidence, and gate decision.
