---
type: Task
id: TASK-220
title: "Build Praxis mobile navigation and shared appearance"
status: planned
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

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
