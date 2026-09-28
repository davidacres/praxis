---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-210
title: "Add discovery and manual host resolution"
status: complete
story: FX-BE-077
updated: 2026-09-09
dependencies: [FX-BE-076]
---

# TASK-210: Add discovery and manual host resolution

**Priority:** High
**Created:** 2026-09-09

## Goal

Advertise local service identity using supported service discovery; use last-known address and manual hostname/IP/port fallback. Treat all discovery results as untrusted hints and authenticate against paired identity.

## Implementation entry points

Desktop local discovery/listener; mobile transport adapter. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- DHCP address changes reconnect to the same host; a different machine at the old IP fails authentication. Blocked discovery still permits manual access on an allowed network.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-076

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Implemented untrusted discovery-hint resolution with authenticated host identity verification.

- Source: packages/core/src/host/mobileHostDiscovery.ts
- Tests: packages/core/src/host/mobileHostDiscovery.test.ts
- Discovery, manual, and last-known addresses are treated as hints only; a paired host identity verifier must approve the selected endpoint.
- Verification: deterministic discovery and last-known fallback tests were added; hosted Actions remain unavailable.
- Remaining limitation: platform mDNS/service-discovery and socket adapters remain transport integration work.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Comments


