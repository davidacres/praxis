---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-222
title: "Implement work list and session restoration"
status: complete
story: FX-BE-081
updated: 2026-09-09
dependencies: [FX-BE-080, FX-BE-077]
---

# TASK-222: Implement work list and session restoration

**Priority:** High
**Created:** 2026-09-09

## Goal

Load authorised projects, active work, recent sessions and paginated history from host. Scope caches and navigation by host/project/session identity; restore selected work after reconnect and app restart.

## Implementation entry points

Mobile renderer work/session/progress/changes features and client transport. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Duplicate issue keys across projects stay separate; host switching cannot expose stale data from another host. Empty, loading, denied and offline states are distinct.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-080
- FX-BE-077

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Implemented host/project/session/work scoped restoration helpers.

- Source: apps/praxis-mobile/renderer/mobileWorkSession.ts
- Tests: apps/praxis-mobile/renderer/mobileWorkSession.test.ts
- Cache keys include host, project, session, and work identity, preventing duplicate issue keys and stale host data from colliding.
- Verification: deterministic scope and stale-restore tests were added; hosted Actions remain unavailable.
- Remaining limitation: host snapshot transport and concrete loading/offline UI states remain renderer integration work.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Comments


