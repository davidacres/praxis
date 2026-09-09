---
type: Story
id: FX-BE-085
title: "Operational release and repository extraction"
status: complete
feature: FX-BF-033
updated: 2026-09-09
dependencies: [FX-BE-084]
---

# FX-BE-085: Operational release and repository extraction

**Priority:** High
**Created:** 2026-09-09

## Outcome

Operational release and repository extraction delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

Mobile documentation/release pipelines, connection API operations and shared contract packaging.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-234](tasks/task-234-prepare-release-operations-and-rollback.md) | Prepare release operations and rollback |
| 2 | [TASK-235](tasks/task-235-prove-standalone-repository-portability.md) | Prove standalone repository portability |
| 3 | [TASK-236](tasks/task-236-complete-release-acceptance-and-documentation.md) | Complete release acceptance and documentation |

## Acceptance criteria

- A release candidate installs on supported devices; incompatible host versions explain upgrade requirements. Rollback and remote-disable drills preserve durable work and local access.
- A temporary standalone copy builds against pinned contracts with fake host and resolves all internal documentation links. No relative runtime imports reach desktop or root core source.
- Release checklist links real evidence for every story; none is marked done merely because plans exist. Signed-out desktop and LAN use remain regression gates; no boards/workflows administration or VPN requirement has crept in.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-084

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
