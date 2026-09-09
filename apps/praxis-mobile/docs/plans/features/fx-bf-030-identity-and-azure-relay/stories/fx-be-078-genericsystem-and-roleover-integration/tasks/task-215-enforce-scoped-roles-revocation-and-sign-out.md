---
type: Task
id: TASK-215
title: "Enforce scoped roles revocation and sign-out"
status: planned
story: FX-BE-078
updated: 2026-09-09
dependencies: [TASK-214]
---

# TASK-215: Enforce scoped roles revocation and sign-out

**Priority:** High
**Created:** 2026-09-09

## Goal

Map view/execute/approve/administer-access permissions to host/project resources via Roleover. Derive actor from verified identity, never client text; enforce policy again at host. Specify short grant lifetimes and a measured revocation bound; no indefinite authorisation cache.

## Implementation entry points

Existing GenericSystem/Roleover repositories after audit; proposed Praxis connection API and desktop/mobile identity adapters. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Cross-user/tenant/project access fails; execute does not imply approve or gate bypass. Desktop sign-out closes relay channels and invalidates remote grants while local jobs and separately permitted local pairing remain usable.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-214

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
