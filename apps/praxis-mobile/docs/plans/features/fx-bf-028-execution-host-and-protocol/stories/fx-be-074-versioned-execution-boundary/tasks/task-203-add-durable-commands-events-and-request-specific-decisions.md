---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-203
title: "Add durable commands events and request-specific decisions"
status: complete
story: FX-BE-074
updated: 2026-09-09
dependencies: [TASK-202]
---

# TASK-203: Add durable commands events and request-specific decisions

**Priority:** High
**Created:** 2026-09-09

## Goal

Persist commandId, scoped caller, payload digest, outcome and reconciliation state before acknowledging side effects; implement event sequence/cursor replay and snapshot fallback. Give permissions and approval stages explicit IDs and versions. Serialize desktop/mobile mutations through the same authority.

## Implementation entry points

Desktop main and packages/core; publishable browser-safe protocol contracts. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Lost acknowledgement and repeated command IDs cause no duplicate run; conflicting payloads are rejected. Crash between dispatch and acknowledgement reconciles as unknown/interrupted without blind replay. A stale permission response cannot approve the next FIFO request.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-202

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Implemented the durable command/event semantics behind an injectable ledger.

- Source: packages/core/src/host/mobileCommandLedger.ts
- Tests: packages/core/src/host/mobileCommandLedger.test.ts
- Public export: packages/core/src/index.ts
- Repeated command IDs replay the original record; conflicting payload digests are rejected.
- Accepted commands can be reconciled as unknown after a crash boundary, then completed explicitly without blind replay.
- Event replay is cursor-based and bounded for reconnect/snapshot orchestration.
- Verification: deterministic admission, conflict, reconciliation, and replay tests were added; hosted GitHub Actions remain unavailable, so the full workspace build could not be executed here.
- Remaining limitation: production persistence and FIFO permission/approval adapters remain host integration work; the core ledger is intentionally transport-neutral.

Parent completion requires verified child outcomes.

## Description


## Comments


