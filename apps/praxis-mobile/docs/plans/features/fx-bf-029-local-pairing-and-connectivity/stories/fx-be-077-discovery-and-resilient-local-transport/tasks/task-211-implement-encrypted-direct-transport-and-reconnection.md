---
type: Task
id: TASK-211
title: "Implement encrypted direct transport and reconnection"
status: planned
story: FX-BE-077
updated: 2026-09-09
dependencies: [TASK-210]
---

# TASK-211: Implement encrypted direct transport and reconnection

**Priority:** High
**Created:** 2026-09-09

## Goal

Carry protocol v1 over authenticated encrypted local transport with bounded payloads, heartbeats, backoff and cancellation. Prefer LAN when available; route changes reuse operation IDs and event cursors.

## Implementation entry points

Desktop local discovery/listener; mobile transport adapter. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Disconnect during streaming resumes without transcript duplication; cursor eviction triggers a bounded snapshot. IPv4/IPv6, guest-network isolation and host sleep show accurate status.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-210

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
