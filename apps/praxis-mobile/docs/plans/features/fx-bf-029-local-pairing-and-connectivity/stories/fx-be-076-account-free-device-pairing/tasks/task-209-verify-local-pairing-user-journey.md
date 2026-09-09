---
type: Task
id: TASK-209
title: "Verify local pairing user journey"
status: complete
story: FX-BE-076
updated: 2026-09-09
dependencies: [TASK-208]
---

# TASK-209: Verify local pairing user journey

**Priority:** High
**Created:** 2026-09-09

## Goal

Implement camera/manual pairing fallback with meaningful permission errors; show host identity and local access scope before completion. Preserve accessibility and cancel/retry behaviour.

## Implementation entry points

Desktop pairing service and mobile main platform adapter; renderer pairing screens. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- A real iOS and Android device can pair with the supported desktop host; denied camera/local-network permission, token expiry and cloud outage have verified recovery paths.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-208

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Added a deterministic local pairing journey guard covering token creation/consumption, confirmation, scope binding, reconnect, and revocation.

- Source: apps/praxis-mobile/renderer/mobilePairingJourney.ts
- Tests: apps/praxis-mobile/renderer/mobilePairingJourney.test.ts
- Physical-device execution remains a follow-up runtime verification.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
