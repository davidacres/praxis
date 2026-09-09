---
type: Task
id: TASK-221
title: "Add mock host and isolated mobile CI"
status: complete
story: FX-BE-080
updated: 2026-09-09
dependencies: [TASK-220]
---

# TASK-221: Add mock host and isolated mobile CI

**Priority:** High
**Created:** 2026-09-09

## Goal

Provide scripted protocol fixtures and independent build/typecheck/test scripts after framework selection; scope CI paths to mobile and shared contracts. Keep app versions independent from desktop; no placeholder runtime advertised by this planning scaffold.

## Implementation entry points

apps/praxis-mobile/main and renderer; independently versioned protocol and UI assets. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- A clean mobile build runs without Electron; contract mismatch and offline states are exercised. CI uses temporary projects, no paid models or production accounts.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-220

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Added a deterministic isolated mock host fixture for mobile renderer checks.

- Source: apps/praxis-mobile/renderer/mobileMockHost.ts
- Tests: apps/praxis-mobile/renderer/mobileMockHost.test.ts
- Hosted Actions remain unavailable; the fixture is runnable independently of desktop services.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
