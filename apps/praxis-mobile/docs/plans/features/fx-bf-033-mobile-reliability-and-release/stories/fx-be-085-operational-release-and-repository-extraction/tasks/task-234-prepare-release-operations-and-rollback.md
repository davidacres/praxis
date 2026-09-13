---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-234
title: "Prepare release operations and rollback"
status: complete
story: FX-BE-085
updated: 2026-09-09
dependencies: [FX-BE-084]
---

# TASK-234: Prepare release operations and rollback

**Priority:** High
**Created:** 2026-09-09

## Goal

Define supported OS/version matrix, signing/distribution, environment separation, relay budgets/alerts, credential rotation and incident response. Add staged rollout and kill switch for internet access without disabling local work.

## Implementation entry points

Mobile documentation/release pipelines, connection API operations and shared contract packaging. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- A release candidate installs on supported devices; incompatible host versions explain upgrade requirements. Rollback and remote-disable drills preserve durable work and local access.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-084

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Comments


