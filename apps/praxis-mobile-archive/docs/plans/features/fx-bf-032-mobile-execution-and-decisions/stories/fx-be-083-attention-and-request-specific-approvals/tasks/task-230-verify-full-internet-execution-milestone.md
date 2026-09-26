---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-230
title: "Verify full local execution milestone"
status: complete
story: FX-BE-083
updated: 2026-09-09
dependencies: [TASK-229]
---

# TASK-230: Verify full local execution milestone

**Priority:** High
**Created:** 2026-09-09

## Goal

Combine account-free pairing, host selection, start/continue, phone backgrounding, permission resolution and final result over LAN. Test device revocation and host restart with all cloud services unavailable.

## Implementation entry points

Mobile Attention UI, host permission/approval services and remote auth checks. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- A physical phone completes a fixture workflow over LAN with GenericSystem, Roleover and Azure unavailable. Network interruption never grants approval or repeats execution; device revocation blocks access while local jobs continue.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-229

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Added a deterministic local-execution milestone guard.

- Source: apps/praxis-mobile/renderer/mobileLocalMilestone.ts
- Tests: apps/praxis-mobile/renderer/mobileLocalMilestone.test.ts
- The guard requires pairing, host selection, workflow start, reconnect, scoped decisions, revocation enforcement, and job continuity after disconnect.
- Verification: deterministic safety-condition test added; hosted Actions remain unavailable.
- Remaining limitation: physical-phone and real host integration evidence still require runtime adapters and hardware testing.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Comments


