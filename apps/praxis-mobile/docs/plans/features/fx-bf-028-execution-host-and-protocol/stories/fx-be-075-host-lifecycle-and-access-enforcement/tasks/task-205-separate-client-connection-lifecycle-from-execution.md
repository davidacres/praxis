---
type: Task
id: TASK-205
title: "Separate client connection lifecycle from execution"
status: planned
story: FX-BE-075
updated: 2026-09-09
dependencies: [TASK-204]
---

# TASK-205: Separate client connection lifecycle from execution

**Priority:** High
**Created:** 2026-09-09

## Goal

Ensure phone disconnect/lock, relay loss and desktop sign-out detach clients without aborting local jobs. Define desktop close/sleep/quit behaviour honestly; no always-on daemon in MVP. Retain durable run state and recover interrupted host work.

## Implementation entry points

Desktop main services, settings and renderer Settings → Mobile access. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Host offline is distinct from run failure; host restart uses existing recovery and never silently starts a second job. Closing the phone leaves the fixture agent running.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-204

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
