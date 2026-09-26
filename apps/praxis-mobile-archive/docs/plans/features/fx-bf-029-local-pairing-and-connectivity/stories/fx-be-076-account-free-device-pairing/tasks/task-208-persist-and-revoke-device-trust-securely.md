---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-208
title: "Persist and revoke device trust securely"
status: complete
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

Implemented the transport-neutral trusted-device store contract.

- Source: packages/core/src/host/mobileTrustStore.ts
- Tests: packages/core/src/host/mobileTrustStore.test.ts
- Public export: packages/core/src/index.ts
- Trusted records retain public identity, host-key fingerprint, project grants, and revocation state; no private-key field is modeled.
- Reconnect requires an active device and matching host-key fingerprint; revocation is idempotent and host-key rotation invalidates the previous fingerprint.
- Verification: deterministic reconnect, revocation, and host-rotation tests were added; hosted GitHub Actions remain unavailable, so the full workspace build could not be executed here.
- Remaining limitation: OS keychain adapters and existing-channel teardown remain platform integration work.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Comments


