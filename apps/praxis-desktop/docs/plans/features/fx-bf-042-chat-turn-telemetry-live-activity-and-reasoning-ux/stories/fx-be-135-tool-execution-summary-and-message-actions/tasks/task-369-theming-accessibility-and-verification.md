---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-369
title: Verification, theming compatibility across surface packs, and accessibility/keyboard focus testing
status: Complete
story: FX-BE-135
feature: FX-BF-042
updated: 2026-09-20
---

# TASK-369: Verification, theming compatibility across surface packs, and accessibility/keyboard focus testing

## Outcome

All new chat telemetry UI elements, activity indicators, metric chips, and
interactive controls are rigorously verified across all themes, surface packs,
and keyboard navigation paths with no layout regressions or accessibility violations.

## Scope

- Test telemetry elements across dark, light, high-contrast, and custom themes.
- Test against all surface packs (`flat`, `parchment`, `graphite`, `aurora`, etc.)
  to ensure backdrop filters and text contrast tokens are preserved.
- Verify focus rings conform to the global `:focus-visible` contract in `theme.css`.
- Confirm core import boundaries (`checkCoreImports`) are strictly honored.
- Execute unit and integration test suites.

## Acceptance criteria

- Telemetry chips, timers, and tool pills render cleanly with high contrast in
  all themes.
- Keyboard navigation tabs logically through message controls without getting
  trapped or skipping focus rings.
- No direct value imports from `@praxis/core` in renderer files.
- All workspace typechecks and production builds succeed.

## Validation

- `npm run check-types`
- `npm run check-core-imports --workspace=@praxis/desktop-renderer`
- `npm run build --workspace=@praxis/desktop-renderer`
- `npm run test:core`

## Description


## Dependencies


## Comments
