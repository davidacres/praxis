---
type: Story
id: FX-BE-080
title: "Portable mobile application foundation"
status: in-progress
feature: FX-BF-031
updated: 2026-09-09
dependencies: [FX-BE-074]
---

# FX-BE-080: Portable mobile application foundation

**Priority:** High
**Created:** 2026-09-09

## Outcome

Portable mobile application foundation delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

apps/praxis-mobile/main and renderer; independently versioned protocol and UI assets.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-219](tasks/task-219-select-mobile-packaging-and-establish-build-boundaries.md) | Select mobile packaging and establish build boundaries |
| 2 | [TASK-220](tasks/task-220-build-praxis-mobile-navigation-and-shared-appearance.md) | Build Praxis mobile navigation and shared appearance |
| 3 | [TASK-221](tasks/task-221-add-mock-host-and-isolated-mobile-ci.md) | Add mock host and isolated mobile CI |

## Acceptance criteria

- ADR records real platform constraints and distribution implications. Mobile consumes versioned contracts/assets without imports into desktop source or Node core; a separate-repository checkout design is documented.
- Inspected captures cover narrow phones, light/dark and palette/surface axes, large text and keyboard. No board/workflow/agent management destinations or desktop multi-pane squeeze appear.
- A clean mobile build runs without Electron; contract mismatch and offline states are exercised. CI uses temporary projects, no paid models or production accounts.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-074

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
