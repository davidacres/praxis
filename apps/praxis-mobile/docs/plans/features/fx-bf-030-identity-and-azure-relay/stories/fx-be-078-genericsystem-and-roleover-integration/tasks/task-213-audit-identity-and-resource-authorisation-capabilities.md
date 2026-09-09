---
type: Task
id: TASK-213
title: "Audit identity and resource authorisation capabilities"
status: backlog
story: FX-BE-078
updated: 2026-09-09
dependencies: [FX-BE-075]
---

# TASK-213: Audit identity and resource authorisation capabilities

**Priority:** Low
**Created:** 2026-09-09

## Goal

Inspect the actual GenericSystem and Roleover sources and deployment contracts before choosing endpoints. Record issuer/audience validation, public-client auth with PKCE, refresh/logout, JWKS rotation, host/project RBAC, tenant boundaries and service identities. Create explicit gap work where unsupported.

## Implementation entry points

Existing GenericSystem/Roleover repositories after audit; proposed Praxis connection API and desktop/mobile identity adapters. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- An evidence-backed capability matrix names source commits and integration tests; no assumed endpoint or permission model is treated as implemented. Confirm service/repository names instead of inferring them.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-075

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
