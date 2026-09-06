---
**Status:** 📋 Proposed
**Created:** 2026-09-06T13:41:43.989Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-017
title: Advanced Settings boundary and verification
status: complete
feature: FX-BF-011
issue: docs/issues/features/fx-bf-011-agent-runtime-session-integration/stories/fx-be-017-agent-hub-verification-and-settings-migration/issue.md
updated: 2026-08-31
tasks: [TASK-090, TASK-091]
dependencies: [FX-BE-015, FX-BE-016]
validation: [npm run check-types, npm run build:renderer, npm run desktop:copy-renderer, focused Playwright tests]
---

# Advanced Settings boundary and verification

## Impact

Runtime configuration has one clear home and the new Agent Hub is verified at the visible desktop layer.

## Scope

- Retain paths, trust policy, project policy, and diagnostics in Settings.
- Remove duplicate everyday catalog actions from Settings.
- Accessibility, visual, error-state, and packaged desktop verification.

## Acceptance criteria

- Settings remains useful for advanced configuration without duplicating the catalog.
- Keyboard navigation and focus states work across tree, detail, and wizard views.
- E2E tests load the copied renderer and inspect visible Agent Hub behavior.

## Close when

The Agent Hub and Settings boundary are coherent and all affected checks pass.

## Description


## Dependencies



## Comments


