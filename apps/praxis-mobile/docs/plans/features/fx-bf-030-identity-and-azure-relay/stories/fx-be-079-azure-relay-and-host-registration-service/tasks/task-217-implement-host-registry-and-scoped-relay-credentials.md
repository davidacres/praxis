---
type: Task
id: TASK-217
title: "Implement host registry and scoped relay credentials"
status: planned
story: FX-BE-079
updated: 2026-09-09
dependencies: [TASK-216]
---

# TASK-217: Implement host registry and scoped relay credentials

**Priority:** High
**Created:** 2026-09-09

## Goal

Register opaque host IDs bound to authenticated owner and host public key. Return only Roleover-authorised hosts; expose bounded freshness/availability. Issue short-lived per-host send/listen grants without exposing namespace management keys. Provision repeatable environment config and rate limits.

## Implementation entry points

Proposed small ASP.NET Core Praxis connection API, Azure deployment configuration and desktop/mobile relay adapters. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- A guessed host ID, forged heartbeat, revoked device, mismatched account or cross-tenant request gets no usable route. Credentials renew safely and are absent from logs and committed config.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-216

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
