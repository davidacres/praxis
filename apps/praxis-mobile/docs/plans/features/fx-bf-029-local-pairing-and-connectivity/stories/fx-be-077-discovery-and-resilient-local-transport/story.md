---
type: Story
id: FX-BE-077
title: "Discovery and resilient local transport"
status: planned
feature: FX-BF-029
updated: 2026-09-09
dependencies: [FX-BE-076]
---

# FX-BE-077: Discovery and resilient local transport

**Priority:** High
**Created:** 2026-09-09

## Outcome

Discovery and resilient local transport delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

Desktop local discovery/listener; mobile transport adapter.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-210](tasks/task-210-add-discovery-and-manual-host-resolution.md) | Add discovery and manual host resolution |
| 2 | [TASK-211](tasks/task-211-implement-encrypted-direct-transport-and-reconnection.md) | Implement encrypted direct transport and reconnection |
| 3 | [TASK-212](tasks/task-212-prove-lan-only-execution-without-cloud-dependencies.md) | Prove LAN-only execution without cloud dependencies |

## Acceptance criteria

- DHCP address changes reconnect to the same host; a different machine at the old IP fails authentication. Blocked discovery still permits manual access on an allowed network.
- Disconnect during streaming resumes without transcript duplication; cursor eviction triggers a bounded snapshot. IPv4/IPv6, guest-network isolation and host sleep show accurate status.
- No GenericSystem, Roleover, Azure, VPN or public DNS is needed for the local journey. Local-only cannot be bypassed by retaining a previously authorised relay connection.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-076

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
