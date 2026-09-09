---
type: Task
id: TASK-212
title: "Prove LAN-only execution without cloud dependencies"
status: planned
story: FX-BE-077
updated: 2026-09-09
dependencies: [TASK-211]
---

# TASK-212: Prove LAN-only execution without cloud dependencies

**Priority:** High
**Created:** 2026-09-09

## Goal

Run local pairing, discovery, read, follow-up and permission flows against fixture host operations with outbound internet blocked. Verify selected interface restrictions on supported desktops.

## Implementation entry points

Desktop local discovery/listener; mobile transport adapter. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- No GenericSystem, Roleover, Azure, VPN or public DNS is needed for the local journey. Local-only cannot be bypassed by retaining a previously authorised relay connection.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-211

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
