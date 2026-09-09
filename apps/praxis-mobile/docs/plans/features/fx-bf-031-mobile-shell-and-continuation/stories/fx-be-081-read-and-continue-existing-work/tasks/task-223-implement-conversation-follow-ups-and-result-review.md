---
type: Task
id: TASK-223
title: "Implement conversation follow-ups and result review"
status: planned
story: FX-BE-081
updated: 2026-09-09
dependencies: [TASK-222]
---

# TASK-223: Implement conversation follow-ups and result review

**Priority:** High
**Created:** 2026-09-09

## Goal

Render transcript, current task snapshot, workflow progress and bounded file/diff views. Send follow-up commands to the same recorded session using host capability rules. Preserve drafts locally; do not queue offline execution for later automatic sending.

## Implementation entry points

Mobile renderer work/session/progress/changes features and client transport. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Desktop → phone → desktop keeps session/run IDs and provider context. Binary/oversized files and unsafe paths are refused or clearly truncated; unsupported continuation is explicit.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-222

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
