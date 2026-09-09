---
type: Task
id: TASK-208
title: "Persist and revoke device trust securely"
status: planned
story: FX-BE-076
updated: 2026-09-09
dependencies: [TASK-207]
---

# TASK-208: Persist and revoke device trust securely

**Priority:** High
**Created:** 2026-09-09

## Goal

Store private keys in OS-protected desktop/mobile storage; retain public identity and scoped grants separately. Define device rename, lost-phone revocation, reinstall/re-pair and host key rotation.

## Implementation entry points

Desktop pairing service and mobile main platform adapter; renderer pairing screens. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- No private keys enter logs, QR history or portable project files. Revoked devices fail both reconnect and existing channels; host identity change requires deliberate re-pairing.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-207

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
