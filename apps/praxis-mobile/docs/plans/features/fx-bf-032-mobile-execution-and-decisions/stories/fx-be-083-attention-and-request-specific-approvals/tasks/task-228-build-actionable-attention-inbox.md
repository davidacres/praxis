---
type: Task
id: TASK-228
title: "Build actionable attention inbox"
status: planned
story: FX-BE-083
updated: 2026-09-09
dependencies: [FX-BE-082, FX-BE-079]
---

# TASK-228: Build actionable attention inbox

**Priority:** High
**Created:** 2026-09-09

## Goal

Aggregate unresolved agent requests, workflow gates and failures with exact request/stage/version identifiers. Show requested action, affected resource and available decisions; retain host/project context.

## Implementation entry points

Mobile Attention UI, host permission/approval services and remote auth checks. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Resolving on desktop removes or marks the phone item resolved. Expired or superseded items cannot target a later request; pagination does not hide active decisions.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-082
- FX-BE-079

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
