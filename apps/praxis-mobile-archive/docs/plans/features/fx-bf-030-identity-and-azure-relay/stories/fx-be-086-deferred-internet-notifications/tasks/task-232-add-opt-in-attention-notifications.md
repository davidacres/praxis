---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-232
title: "Add opt-in attention notifications"
status: backlog
story: FX-BE-086
updated: 2026-09-09
dependencies: [FX-BE-079, FX-BE-085]
---

# TASK-232: Add opt-in attention notifications

**Priority:** Low
**Created:** 2026-09-09

## Goal

Implement iOS/Android push registration only after platform proof. Notifications carry minimal opaque references, no transcript or approval secrets; opening re-authenticates and fetches current state. Local-only has no cloud push dependency and must describe its limitation.

## Implementation entry points

Mobile main lifecycle/push adapters, renderer connection state and connection API notification metadata. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Denied push permission leaves foreground execution usable. Revoked/logged-out devices stop receiving registered remote notifications; stale deep links cannot approve or execute.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-079
- FX-BE-085

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Description


## Comments


