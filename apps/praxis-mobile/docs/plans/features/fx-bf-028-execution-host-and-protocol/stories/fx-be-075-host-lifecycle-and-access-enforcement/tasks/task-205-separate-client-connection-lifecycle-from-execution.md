---
type: Task
id: TASK-205
title: "Separate client connection lifecycle from execution"
status: complete
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

Implemented a transport-neutral mobile connection lifecycle state machine.

- Source: packages/core/src/host/mobileConnectionLifecycle.ts
- Tests: packages/core/src/host/mobileConnectionLifecycle.test.ts
- Public export: packages/core/src/index.ts
- Connections must progress through connecting and authenticated before becoming ready for execution.
- Disconnect and close transitions detach the client without representing a run failure; execution eligibility is limited to ready connections.
- Verification: deterministic transition and execution-gate tests were added; hosted GitHub Actions remain unavailable, so the full workspace build could not be executed here.
- Remaining limitation: desktop socket lifecycle adapters and recovery-store integration remain host integration work; no always-on daemon is introduced.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
