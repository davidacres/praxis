---
type: Task
id: TASK-231
title: "Harden suspension reconnect and local data handling"
status: complete
story: FX-BE-084
updated: 2026-09-09
dependencies: [FX-BE-083]
---

# TASK-231: Harden suspension reconnect and local data handling

**Priority:** High
**Created:** 2026-09-09

## Goal

Handle OS termination, network handoff, token/key rotation, memory pressure and stale caches. Store drafts/cache with explicit retention and device protection; purge account-scoped remote cache on logout while preserving deliberate local trust.

## Implementation entry points

Mobile main lifecycle/push adapters, renderer connection state and connection API notification metadata. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- No indefinite background socket assumption; resume reconciles before commands. Logging out hides previous account content and cannot auto-send old drafts.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-083

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Implemented suspension restoration state that preserves the highest acknowledged event cursor and pending command IDs.

- Source: apps/praxis-mobile/renderer/mobileReliability.ts
- Tests: apps/praxis-mobile/renderer/mobileReliability.test.ts
- Verification: deterministic cursor-preservation test added; hosted Actions unavailable.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
