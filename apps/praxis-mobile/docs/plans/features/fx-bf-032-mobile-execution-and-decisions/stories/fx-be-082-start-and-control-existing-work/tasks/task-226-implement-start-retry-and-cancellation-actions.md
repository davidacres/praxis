---
type: Task
id: TASK-226
title: "Implement start retry and cancellation actions"
status: planned
story: FX-BE-082
updated: 2026-09-09
dependencies: [TASK-225]
---

# TASK-226: Implement start retry and cancellation actions

**Priority:** High
**Created:** 2026-09-09

## Goal

Dispatch deduplicated commands through the shared application services; surface workflow stage progress and governed retry/cancel. Session follow-up and stage retry remain distinct; no manual success fabrication or bypass endpoint in MVP.

## Implementation entry points

Mobile Work start form; host execution services and existing agent/workflow catalog. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Double tap, lost acknowledgement and reconnection create one run. Cancellation reaches active host execution; retry follows existing policy and never silently starts a new unrelated conversation.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-225

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
