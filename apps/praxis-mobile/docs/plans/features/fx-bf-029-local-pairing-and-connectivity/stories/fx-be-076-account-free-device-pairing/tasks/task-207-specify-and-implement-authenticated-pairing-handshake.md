---
type: Task
id: TASK-207
title: "Specify and implement authenticated pairing handshake"
status: planned
story: FX-BE-076
updated: 2026-09-09
dependencies: [FX-BE-075]
---

# TASK-207: Specify and implement authenticated pairing handshake

**Priority:** High
**Created:** 2026-09-09

## Goal

Use established cryptographic libraries and authenticated key exchange. QR contains host identity, endpoint hints and expiring single-use token, never a reusable secret. Require desktop confirmation of the requesting device; bind device public key and allowed project scope.

## Implementation entry points

Desktop pairing service and mobile main platform adapter; renderer pairing screens. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Expired, replayed and concurrently consumed QR tokens fail; substituted host identity and unconfirmed devices are rejected. Pairing succeeds with internet/DNS access blocked.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-075

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
