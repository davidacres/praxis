---
type: Task
id: TASK-216
title: "Prototype Azure Relay compatibility and cost"
status: planned
story: FX-BE-079
updated: 2026-09-09
dependencies: [FX-BE-078, FX-BE-076]
---

# TASK-216: Prototype Azure Relay compatibility and cost

**Priority:** High
**Created:** 2026-09-09

## Goal

Prove outbound-only desktop listener and mobile sender for the chosen Node/mobile stacks. Measure connection limits, payload/backpressure, latency, reconnect/renewal and estimated idle/active costs against current Azure documentation. Record supported platforms and a go/no-go ADR.

## Implementation entry points

Proposed small ASP.NET Core Praxis connection API, Azure deployment configuration and desktop/mobile relay adapters. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- One desktop and one physical phone exchange encrypted fixture commands from separate networks with no inbound router ports or VPN. Record real-service evidence separately from mocks; infrastructure use is an explicit opt-in.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-078
- FX-BE-076

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
