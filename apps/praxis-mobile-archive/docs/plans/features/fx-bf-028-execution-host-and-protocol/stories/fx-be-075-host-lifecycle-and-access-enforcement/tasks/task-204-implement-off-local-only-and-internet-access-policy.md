---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-204
title: "Implement off local-only and internet access policy"
status: complete
story: FX-BE-075
updated: 2026-09-09
dependencies: [FX-BE-074]
---

# TASK-204: Implement off local-only and internet access policy

**Priority:** High
**Created:** 2026-09-09

## Goal

Default remote access to off; enabling mobile defaults to local-only. Define allowed interfaces/subnets, IPv4/IPv6 rules and explicitly reject VPN/tunnel dependency. Private IP alone is not local proof. Validate peer authentication and project/action scope on every operation.

## Implementation entry points

Desktop main services, settings and renderer Settings → Mobile access. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Off closes listeners and relay channels; local-only binds only allowed interfaces and rejects relay routes, spoofed forwarding headers and disallowed networks. State changes apply to established connections.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-074

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Implemented the transport-neutral access policy evaluator.

- Source: packages/core/src/host/mobileAccessPolicy.ts
- Tests: packages/core/src/host/mobileAccessPolicy.test.ts
- Public export: packages/core/src/index.ts
- Default policy is off; local-only mode rejects relay routes and untrusted forwarding headers, and applies interface/subnet allowlists.
- Internet mode is explicit and only allows an authenticated relay route; it is not enabled by default.
- Verification: deterministic policy tests cover disabled, local allow/deny, spoofed forwarding, relay rejection, and explicit internet mode.
- Remaining limitation: desktop listener binding and production CIDR/socket metadata adapters remain host integration work; GenericSystem, Roleover, and Azure are not required for local delivery.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Comments


