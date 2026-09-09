---
type: Task
id: TASK-229
title: "Implement scoped decision commands"
status: planned
story: FX-BE-083
updated: 2026-09-09
dependencies: [TASK-228]
---

# TASK-229: Implement scoped decision commands

**Priority:** High
**Created:** 2026-09-09

## Goal

Provide allow-once/deny and supported workflow approval with server-derived actor and reason where needed. Keep persistent allow and gate bypass outside MVP unless separately reviewed. Enforce paired local grants or current remote Roleover permission plus workflow policy.

## Implementation entry points

Mobile Attention UI, host permission/approval services and remote auth checks. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- View/execute-only devices cannot approve. Wrong request, wrong stage, stale version and duplicate response produce explicit conflict/already-resolved results with no second side effect.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-228

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
