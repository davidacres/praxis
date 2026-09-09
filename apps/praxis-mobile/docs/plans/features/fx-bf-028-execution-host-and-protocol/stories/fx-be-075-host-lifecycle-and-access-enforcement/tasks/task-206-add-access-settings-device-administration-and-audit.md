---
type: Task
id: TASK-206
title: "Add access settings device administration and audit"
status: planned
story: FX-BE-075
updated: 2026-09-09
dependencies: [TASK-205]
---

# TASK-206: Add access settings device administration and audit

**Priority:** High
**Created:** 2026-09-09

## Goal

Add themed settings for modes, allowed networks, paired devices, host name, revocation and internet sign-in entry. Record actor/device/project/action/outcome without secrets or transcript bodies. Keep normal desktop startup account-free.

## Implementation entry points

Desktop main services, settings and renderer Settings → Mobile access. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Clean desktop use never requires sign-in. Revoking a device closes its sessions; mode transitions and denied operations have redacted audit evidence and inspected themed UI captures.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-205

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
