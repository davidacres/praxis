---
type: Task
id: TASK-231
title: "Harden suspension reconnect and local data handling"
status: planned
story: FX-BE-084
updated: 2026-09-09
dependencies: [FX-BE-083, FX-BE-079]
---

# TASK-231: Harden suspension reconnect and local data handling

**Priority:** High
**Created:** 2026-09-09

## Goal

Handle OS termination, network handoff, token/key rotation, memory pressure and stale caches. Store drafts/cache with explicit retention and device protection; purge account-scoped remote cache on logout while preserving deliberate local trust.

## Implementation entry points

Mobile main lifecycle/push adapters, renderer connection state and connection API notification metadata. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- No indefinite background socket assumption; resume reconciles before commands. Logging out hides previous account content and cannot auto-send old drafts.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-083
- FX-BE-079

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
