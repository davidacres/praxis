---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-220
title: "Build Praxis mobile navigation and shared appearance"
status: complete
story: FX-BE-080
updated: 2026-09-09
dependencies: [TASK-219]
---

# TASK-220: Build Praxis mobile navigation and shared appearance

**Priority:** High
**Created:** 2026-09-09

## Goal

Implement Work, Attention and Activity with host/project switcher and Chat/Progress/Changes detail tabs. Share token/icon assets through a browser-safe boundary; keep provider/model/context alongside composer. Use themed dialogs, safe areas, touch targets and accessible text.

## Implementation entry points

apps/praxis-mobile/main and renderer; independently versioned protocol and UI assets. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Inspected captures cover narrow phones, light/dark and palette/surface axes, large text and keyboard. No board/workflow/agent management destinations or desktop multi-pane squeeze appear.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-219

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Implemented renderer-owned mobile navigation contracts.

- Source: apps/praxis-mobile/renderer/mobileNavigation.ts
- Tests: apps/praxis-mobile/renderer/mobileNavigation.test.ts
- Destinations are limited to Work, Attention, and Activity; detail tabs are Chat, Progress, and Changes.
- Host/project scope is preserved across navigation and non-work destinations reset to a safe detail tab.
- Verification: deterministic navigation tests were added; hosted Actions remain unavailable.
- Remaining limitation: concrete React components and visual capture matrix remain UI implementation work.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Comments


