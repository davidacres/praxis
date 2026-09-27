---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:20:00.000Z
**Type:** Task
**Priority:** High
id: TASK-375
title: "Define enableEasyMode setting contract, sanitizer, and renderer defaults"
status: Complete
story: FX-BE-146
feature: FX-BF-046
updated: 2026-09-26
dependencies: []
---

# TASK-375: Define enableEasyMode setting contract, sanitizer, and renderer defaults

## Goal

Establish the core settings contract and synchronized defaults for EasyMode so the feature can be toggled without breaking existing app settings or triggering schema migration errors.

## Dependencies

- None (Can be executed immediately).

## Execution track

- **Track A (Foundation)**: Unblocks `TASK-376` (Simple Theme & Toggle) and `TASK-377` (Sidebar Host).

## Scope

- In `packages/core/src/config/appSettings.ts`:
  - Add `enableEasyMode: boolean` to `PreviewSettings`.
  - Default `enableEasyMode: false` in `DEFAULT_APP_SETTINGS.preview`.
  - Add `'simple'` to `DEFAULT_APP_SETTINGS.appearance.installedThemeIds`.
  - Update `sanitizeAppSettings` and `mergeAppSettings`.
- In `packages/core/src/config/appSettings.test.ts`:
  - Add unit test verifying `enableEasyMode` defaults to `false` and merges cleanly.
- In `apps/praxis-desktop/renderer/src/settings/settingsDefaults.ts`:
  - Mirror `enableEasyMode: false` in `DEFAULT_APP_SETTINGS.preview`.
  - Mirror `'simple'` in `DEFAULT_APP_SETTINGS.appearance.installedThemeIds`.

## Done when

- `npm run test:core` passes.
- `npm run check-core-imports` passes.
- `npm run check-types` compiles clean.

## Description


## Comments

Added `enableEasyMode: boolean` to `PreviewSettings` interface, `DEFAULT_APP_SETTINGS.preview`, `sanitizeAppSettings`, and `mergeAppSettings` in `packages/core/src/config/appSettings.ts`. Added `'simple'` to `installedThemeIds`. Added comprehensive unit tests in `packages/core/src/config/appSettings.test.ts`. Synchronized renderer defaults in `apps/praxis-desktop/renderer/src/settings/settingsDefaults.ts` with no `@praxis/core` value imports. All tests and type checks pass.
