---
type: Story
id: FX-BE-078
title: "GenericSystem and Roleover integration"
status: planned
feature: FX-BF-030
updated: 2026-09-09
dependencies: [FX-BE-075]
---

# FX-BE-078: GenericSystem and Roleover integration

**Priority:** High
**Created:** 2026-09-09

## Outcome

GenericSystem and Roleover integration delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

Existing GenericSystem/Roleover repositories after audit; proposed Praxis connection API and desktop/mobile identity adapters.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-213](tasks/task-213-audit-identity-and-resource-authorisation-capabilities.md) | Audit identity and resource authorisation capabilities |
| 2 | [TASK-214](tasks/task-214-implement-optional-desktop-and-required-internet-sign-in.md) | Implement optional desktop and required internet sign-in |
| 3 | [TASK-215](tasks/task-215-enforce-scoped-roles-revocation-and-sign-out.md) | Enforce scoped roles revocation and sign-out |

## Acceptance criteria

- An evidence-backed capability matrix names source commits and integration tests; no assumed endpoint or permission model is treated as implemented. Confirm service/repository names instead of inferring them.
- Desktop startup and local-only access work signed out. Wrong issuer/audience, expired credentials and token-refresh failure fail remote access closed with a re-authentication path.
- Cross-user/tenant/project access fails; execute does not imply approve or gate bypass. Desktop sign-out closes relay channels and invalidates remote grants while local jobs and separately permitted local pairing remain usable.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-075

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
