---
type: Task
id: TASK-235
title: "Prove standalone repository portability"
status: planned
story: FX-BE-085
updated: 2026-09-09
dependencies: [TASK-234]
---

# TASK-235: Prove standalone repository portability

**Priority:** High
**Created:** 2026-09-09

## Goal

Validate mobile can move with main, renderer, docs, board/project identity and plans intact. Publish/pin shared protocol/UI dependencies, replace any monorepo-only build references and map backend ownership externally; do not move the repo yet.

## Implementation entry points

Mobile documentation/release pipelines, connection API operations and shared contract packaging. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- A temporary standalone copy builds against pinned contracts with fake host and resolves all internal documentation links. No relative runtime imports reach desktop or root core source.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-234

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
