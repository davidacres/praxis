---
type: Story
id: FX-BE-079
title: "Azure Relay and host registration service"
status: planned
feature: FX-BF-030
updated: 2026-09-09
dependencies: [FX-BE-078, FX-BE-076]
---

# FX-BE-079: Azure Relay and host registration service

**Priority:** High
**Created:** 2026-09-09

## Outcome

Azure Relay and host registration service delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

Proposed small ASP.NET Core Praxis connection API, Azure deployment configuration and desktop/mobile relay adapters.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-216](tasks/task-216-prototype-azure-relay-compatibility-and-cost.md) | Prototype Azure Relay compatibility and cost |
| 2 | [TASK-217](tasks/task-217-implement-host-registry-and-scoped-relay-credentials.md) | Implement host registry and scoped relay credentials |
| 3 | [TASK-218](tasks/task-218-secure-end-to-end-relay-traffic-and-route-changes.md) | Secure end-to-end relay traffic and route changes |

## Acceptance criteria

- One desktop and one physical phone exchange encrypted fixture commands from separate networks with no inbound router ports or VPN. Record real-service evidence separately from mocks; infrastructure use is an explicit opt-in.
- A guessed host ID, forged heartbeat, revoked device, mismatched account or cross-tenant request gets no usable route. Credentials renew safely and are absent from logs and committed config.
- Relay operator cannot read fixture payloads; tampering/replay/identity substitution fails. Mobile-data/LAN switching does not duplicate work. Selecting local-only or signing out closes active remote channels and denies old grants.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-078
- FX-BE-076

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
