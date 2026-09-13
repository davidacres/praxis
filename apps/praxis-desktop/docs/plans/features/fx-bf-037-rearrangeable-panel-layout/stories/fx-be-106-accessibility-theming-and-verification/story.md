---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-106
title: "Accessibility, theming and verification"
status: Proposed
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BE-104, FX-BE-105]
---

# FX-BE-106: Accessibility, theming and verification

## Outcome

The rearrangeable layout is accessible, composes correctly with every theme/mode/surface-pack combination, and is proven with the same rigor this app's other visual features require — not just green tests, but reviewed screenshots.

## Tasks

- **TASK-303 Add ARIA roles/labels and screen-reader announcements for drag start, valid drop targets, and completed moves.**
- **TASK-304 Verify `PanelShell` chrome and drop-zone affordances render correctly across the theme/mode/surface-pack matrix, including CSP compliance.**
- **TASK-305 Add end-to-end journey coverage and update `docs/desktop-feature-parity.md`/relevant docs for the new capability.**

## Acceptance

The story is complete when a screen-reader user can discover and complete a panel move via the keyboard fallback with meaningful announcements, `PanelShell`'s new chrome/drop-zone visuals hold up under at least one non-default theme and one non-flat surface pack with reviewed (not just captured) screenshots, `e2e/keyboardFocus.spec.ts` and `e2e/walkthrough.spec.ts` continue to pass unmodified in intent, and the feature is documented for future contributors.

## Evidence

Accessibility audit notes, reviewed `-actual.png` screenshots for each themed/surfaced capture (not blindly accepted), and a full `npm run test:desktop` pass.

## Description


## Dependencies



## Comments
