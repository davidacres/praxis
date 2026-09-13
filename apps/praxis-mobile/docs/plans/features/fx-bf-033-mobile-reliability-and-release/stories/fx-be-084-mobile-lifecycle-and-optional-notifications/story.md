---
**Status:** 📋 Proposed
**Type:** Story
type: Story
id: FX-BE-084
title: "Mobile lifecycle and optional notifications"
status: in-progress
feature: FX-BF-033
updated: 2026-09-09
dependencies: [FX-BE-083]
---

# FX-BE-084: Mobile lifecycle and optional notifications

**Priority:** High
**Created:** 2026-09-09

## Outcome

Mobile lifecycle and optional notifications delivers the following ordered, independently verifiable steps.

## Scope and implementation entry points

Mobile main lifecycle/push adapters, renderer connection state and connection API notification metadata.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-231](tasks/task-231-harden-suspension-reconnect-and-local-data-handling.md) | Harden suspension reconnect and local data handling |
| 2 | [TASK-233](tasks/task-233-verify-interruption-and-accessibility-matrix.md) | Verify interruption and accessibility matrix |

## Acceptance criteria

- No indefinite background socket assumption; resume reconciles before commands. Logging out hides previous account content and cannot auto-send old drafts.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.
- Record measured replay/payload/latency limits and actual device captures. Failures distinguish host offline, unauthorised, reconnecting and interrupted work; no false success banners.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-083

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Comments


