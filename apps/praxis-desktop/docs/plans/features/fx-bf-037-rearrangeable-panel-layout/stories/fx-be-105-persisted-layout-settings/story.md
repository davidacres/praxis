---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-105
title: "Persisted layout settings"
status: Proposed
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BE-102, FX-BF-017]
---

# FX-BE-105: Persisted layout settings

## Outcome

The user's chosen panel arrangement (and per-region sizes) persists across app restarts, via the existing shared-settings document, so rearranging panels is a durable preference rather than a session-only state.

## Tasks

- **TASK-300 Extend `AppSettings` in core with a `layout` field carrying the `LayoutConfig` and per-region sizes.**
- **TASK-301 Mirror the new field in the renderer's `settingsDefaults.ts` and wire read/write through `settings.get`/`settings.set`/`settings.onChanged`.**
- **TASK-302 Load the persisted layout on shell startup and save on every rearrangement/resize, debounced.**

## Acceptance

The story is complete when rearranging panels or resizing a region, then restarting the app, restores the exact same arrangement and sizes; an app with no prior layout preference falls back to the default config from FX-BE-102 without error; and the renderer's `settingsDefaults.ts` mirror stays in sync with core's `DEFAULT_APP_SETTINGS` per this repo's settings-sync rule.

## Evidence

Unit tests for the settings migration/merge logic in core, and an e2e test that rearranges panels, reloads the app window, and asserts the arrangement persisted.

## Description


## Dependencies



## Comments
