---
type: Task
id: TASK-218
title: "Secure end-to-end relay traffic and route changes"
status: backlog
story: FX-BE-079
updated: 2026-09-09
dependencies: [TASK-217]
---

# TASK-218: Secure end-to-end relay traffic and route changes

**Priority:** Low
**Created:** 2026-09-09

## Goal

Authenticate the paired device/host inside the relay using a vetted cryptographic protocol; encryption keys stay at endpoints. Relay TLS alone is insufficient. Reuse LAN protocol identity, command journal and cursors; local preference must never weaken mode enforcement.

## Implementation entry points

Proposed small ASP.NET Core Praxis connection API, Azure deployment configuration and desktop/mobile relay adapters. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Relay operator cannot read fixture payloads; tampering/replay/identity substitution fails. Mobile-data/LAN switching does not duplicate work. Selecting local-only or signing out closes active remote channels and denies old grants.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-217

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Deferred internet milestone evidence

After local release, prove the full mobile start/continue/approve/retry/cancel journey over Azure on a physical phone, including LAN handoff, desktop sign-out, expired grants and device revocation. This is the internet release gate; it is not part of local release acceptance.
