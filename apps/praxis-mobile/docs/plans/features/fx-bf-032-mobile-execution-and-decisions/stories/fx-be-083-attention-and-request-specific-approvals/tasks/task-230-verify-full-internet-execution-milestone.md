---
type: Task
id: TASK-230
title: "Verify full internet execution milestone"
status: planned
story: FX-BE-083
updated: 2026-09-09
dependencies: [TASK-229]
---

# TASK-230: Verify full internet execution milestone

**Priority:** High
**Created:** 2026-09-09

## Goal

Combine relay sign-in, authorised host list, start/continue, phone backgrounding, permission resolution and final result. Switch to LAN mid-run, then test host sign-out and device revocation.

## Implementation entry points

Mobile Attention UI, host permission/approval services and remote auth checks. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- One physical phone completes a fixture workflow via Azure; relay interruption never grants approval or repeats execution. Revocation meets the documented bound and local jobs continue.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-229

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
