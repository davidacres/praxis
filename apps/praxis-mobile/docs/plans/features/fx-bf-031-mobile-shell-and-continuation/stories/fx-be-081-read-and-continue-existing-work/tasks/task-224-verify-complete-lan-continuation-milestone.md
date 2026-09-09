---
type: Task
id: TASK-224
title: "Verify complete LAN continuation milestone"
status: planned
story: FX-BE-081
updated: 2026-09-09
dependencies: [TASK-223]
---

# TASK-224: Verify complete LAN continuation milestone

**Priority:** High
**Created:** 2026-09-09

## Goal

Use a deterministic agent to start work on desktop, open phone, lock/terminate phone, reconnect, send a follow-up and inspect changes on both surfaces. Check duplicate submissions and host restart recovery.

## Implementation entry points

Mobile renderer work/session/progress/changes features and client transport. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Work continues while phone is absent; replay has no missing/duplicate accepted messages. Record physical-device evidence for iOS/Android and retained desktop behaviour before declaring the milestone complete.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-223

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
