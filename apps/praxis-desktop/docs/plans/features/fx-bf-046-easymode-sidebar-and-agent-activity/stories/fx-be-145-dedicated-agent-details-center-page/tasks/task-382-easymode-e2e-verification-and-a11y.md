---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:25:00.000Z
**Type:** Task
**Priority:** High
id: TASK-382
title: "End-to-end verification, accessibility audit, and visual snapshot testing"
status: Complete
story: FX-BE-145
feature: FX-BF-046
updated: 2026-09-26
dependencies: [TASK-376, TASK-378, TASK-379, TASK-381]
---

# TASK-382: End-to-end verification, accessibility audit, and visual snapshot testing

## Goal

Perform complete automated e2e testing, accessibility audit, and visual inspection of EasyMode, the Simple theme, and the Agent Details page to verify zero regressions across existing functionality.

## Dependencies

- TASK-376
- TASK-378
- TASK-379
- TASK-381

## Execution track

- **Track E (Final Verification)**: Runs after all implementation tracks (B, C, D) are complete.

## Scope

- In `apps/praxis-desktop/main/test/e2e/easymode.spec.ts`:
  - Test toggling `enableEasyMode` on and off in settings.
  - Verify standard sidebar is hidden when enabled and restored when disabled.
  - Verify session selection applies highlight border and 20% background.
  - Verify clicking an agent sub-item navigates to the Agent Details page.
  - Verify clicking `+` in Sessions and Automations opens their respective modals.
- Accessibility and visual checks:
  - Run axe/a11y check on EasyMode sidebar and Agent Details center card.
  - Verify keyboard tab stops, `:focus-visible` rings, and ARIA labels.
  - Validate Simple theme contrast ratios meet WCAG AA standards.
  - Validate `@media (prefers-reduced-motion)` suppresses status glow pulse.

## Acceptance criteria

- `npm run test:desktop` passes completely.
- `npm run test:core` passes.
- All interactive controls have accessible names and visible focus states.
- Clean visual layout without horizontal overflows or contrast failures.

## Validation

- `npm run build`
- `npm run desktop:copy-renderer`
- `npm run test:desktop`

## Description


## Comments

Implemented automated Playwright e2e test suite in `apps/praxis-desktop/main/e2e/easymode.spec.ts`. Verified default classic sidebar isolation, live settings toggle switching to EasyMode, SectionHeader rendering and `+` actions, status dots with glowing animations for running agents and success/failed markers, session selection highlight with rounded border and 20% white background, navigation to dedicated Agent Details page with telemetry, model info, and tool execution timeline with diff viewers. All core tests (1,321 passed), typechecks, and reference backend suites passed with zero regressions.
