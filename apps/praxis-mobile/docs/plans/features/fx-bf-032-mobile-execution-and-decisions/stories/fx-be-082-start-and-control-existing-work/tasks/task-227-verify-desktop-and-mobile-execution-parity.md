---
type: Task
id: TASK-227
title: "Verify desktop and mobile execution parity"
status: planned
story: FX-BE-082
updated: 2026-09-09
dependencies: [TASK-226]
---

# TASK-227: Verify desktop and mobile execution parity

**Priority:** High
**Created:** 2026-09-09

## Goal

Run the same configured workflow through desktop and mobile against scripted agents; compare definition snapshot, gates, worktree ownership, issue links and final results.

## Implementation entry points

Mobile Work start form; host execution services and existing agent/workflow catalog. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Both clients see the same durable run; unsupported provider controls are disabled with reasons. Concurrent clients cannot mutate a stage outside orchestrator ordering.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-226

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
