---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-201
title: "Audit execution ownership and freeze protocol v1"
status: complete
story: FX-BE-074
updated: 2026-09-09
dependencies: []
---

# TASK-201: Audit execution ownership and freeze protocol v1

**Priority:** High
**Created:** 2026-09-09

## Goal

Inventory aiIpc, workflowIpc, ipcContracts, aiSessionManager, WorkflowOrchestrator and provider hosts at an exact commit. Define host/project/session/run/request identity, capability negotiation, paginated snapshots, typed errors and command/event envelopes. Keep remote operations allowlisted; omit board/workflow/agent administration and arbitrary IPC forwarding.

## Implementation entry points

Desktop main and packages/core; publishable browser-safe protocol contracts. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- A contract fixture maps every mobile operation to its existing implementation; identical issue keys in different projects or hosts cannot collide. Older/newer clients get explicit compatibility results.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

None.

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Implemented the browser-safe protocol contract and deterministic validation tests.

- Source: packages/core/src/host/mobileProtocol.ts
- Tests: packages/core/src/host/mobileProtocol.test.ts
- Public export: packages/core/src/index.ts
- Contract maps every mobile read/command operation to explicit view, execute, or approve capability.
- Validation covers protocol version, command/device/host identity, mutation project scope, capability enforcement, and event cursors.
- Verification: source and package JSON reviewed through the repository API; hosted GitHub Actions remain unavailable (runner startup failure), so the full workspace build could not be executed here.
- Remaining limitation: host transport adapters, pairing, LAN discovery, and remote relay are subsequent tasks; this contract intentionally contains no network or cloud dependency.

Parent completion requires verified child outcomes.

## Description


## Comments


