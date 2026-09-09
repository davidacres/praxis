---
type: Task
id: TASK-233
title: "Verify interruption and accessibility matrix"
status: planned
story: FX-BE-084
updated: 2026-09-09
dependencies: [TASK-232]
---

# TASK-233: Verify interruption and accessibility matrix

**Priority:** High
**Created:** 2026-09-09

## Goal

Exercise sleep/offline, cloud outage, lost acknowledgements, interrupted host, large histories, slow links, keyboard/large text and screen reader across supported phone/desktop combinations.

## Implementation entry points

Mobile main lifecycle/push adapters, renderer connection state and connection API notification metadata. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Record measured replay/payload/latency limits and actual device captures. Failures distinguish host offline, unauthorised, reconnecting and interrupted work; no false success banners.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-232

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
