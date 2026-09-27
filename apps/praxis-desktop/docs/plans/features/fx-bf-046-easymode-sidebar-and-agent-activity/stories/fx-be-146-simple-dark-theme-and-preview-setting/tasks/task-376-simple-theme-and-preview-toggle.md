---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:25:00.000Z
**Type:** Task
**Priority:** High
id: TASK-376
title: "Register Simple dark theme, CSS theme definition, and Settings Preview toggle"
status: Complete
story: FX-BE-146
feature: FX-BF-046
updated: 2026-09-26
dependencies: [TASK-375]
---

# TASK-376: Register Simple dark theme, CSS theme definition, and Settings Preview toggle

## Goal

Provide a minimalist, high-contrast monochrome dark theme (`simple`) matching the Orca design language, and provide an interactive toggle switch in the Settings > Preview tab to enable or disable EasyMode.

## Dependencies

- TASK-375

## Execution track

- **Track B (Theme & Settings UI)**: Runs in parallel with Sidebar development (Track C: TASK-377 / TASK-378 / TASK-379).

## Scope

- In `apps/praxis-desktop/renderer/src/themes/themeRegistry.ts`:
  - Register `simple` theme entry (`Simple`, dark mode, high contrast, clean palette).
- In `apps/praxis-desktop/renderer/src/themes/theme.css`:
  - Add `[data-theme="simple"]` CSS definition with dark neutral background tokens (`--bg: #0a0a0a`, `--panel: #171717`, `--border: rgba(255,255,255,0.08)`, `--accent: #ffffff`).
- In `apps/praxis-desktop/renderer/src/settings/SettingsDialog.tsx` (or `PreviewSettingsSection.tsx`):
  - Add "EasyMode Sidebar" experimental toggle under Preview features.
  - Wire to `settings.preview.enableEasyMode`.
  - Display helpful description explaining that EasyMode replaces standard project/board panels with Sessions and Automations.

## Acceptance criteria

- Selecting `Simple` in Appearance theme picker switches the app to the `#0a0a0a` palette.
- Toggling "EasyMode Sidebar" in Settings -> Preview persists `preview.enableEasyMode` to app settings.
- Switching themes or toggles triggers no TypeScript or lint warnings.

## Validation

- `npm run check-types`
- `npm run check-core-imports`
- Manual visual inspection of theme picker and settings dialog.

## Description


## Comments

Registered `simple` dark theme definition in `apps/praxis-desktop/renderer/src/settings/themes.ts` with Orca-inspired monochrome palette and high contrast. Added `:root[data-theme='simple']` tokens in `apps/praxis-desktop/renderer/src/theme.css` matching design specs (`#0a0a0a` canvas, `#171717` elevated panel, `#030303` sunken, `#fafafa` typography, `#ffffff` accent). Added the "EasyMode sidebar (experimental)" toggle switch to `PreviewCategory` in `apps/praxis-desktop/renderer/src/settings/SettingsPage.tsx`. Passed all type and import checks.
