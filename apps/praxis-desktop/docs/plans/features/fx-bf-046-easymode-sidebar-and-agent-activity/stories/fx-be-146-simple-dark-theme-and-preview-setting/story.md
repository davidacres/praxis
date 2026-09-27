---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:15:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-146
title: "Simple dark theme and preview setting"
status: Complete
feature: FX-BF-046
updated: 2026-09-26
dependencies: []
---

# FX-BE-146: Simple dark theme and preview setting

## User or operational impact

Introduces the core setting and theme foundation required for EasyMode: an experimental setting in Settings -> Preview to toggle EasyMode on/off safely with zero disruption to existing workflows, and a new built-in **Simple** dark theme reproducing the minimalist palette of Orca (`onorca.dev`).

## Scope

- **Core Settings (`packages/core/src/config/appSettings.ts`)**:
  - Add `enableEasyMode: boolean` to `PreviewSettings`.
  - Default: `enableEasyMode: false` in `DEFAULT_APP_SETTINGS.preview`.
  - Add `'simple'` to `DEFAULT_APP_SETTINGS.appearance.installedThemeIds`.
  - Update `sanitizeAppSettings` and `mergeAppSettings`.
  - Add unit tests in `packages/core/src/config/appSettings.test.ts`.
- **Renderer Settings Mirror (`apps/praxis-desktop/renderer/src/settings/settingsDefaults.ts`)**:
  - Mirror `enableEasyMode: false` and `'simple'` in `DEFAULT_APP_SETTINGS`.
- **Settings UI (`SettingsPage.tsx`)**:
  - Add experimental toggle in `PreviewSection`:
    - Label: "EasyMode sidebar (experimental)"
    - Description: "Replaces standard sidebar trees with a simplified Sessions and Automations workspace."
- **Simple Theme Definition (`themes.ts`)**:
  - Add `simple` to `BUILT_IN_THEMES`:
    - `id: 'simple'`, `name: 'Simple'`, `family: 'Praxis'`, `mode: 'dark'`.
    - Description: "Clean, minimalist dark palette inspired by Orca with neutral charcoals and crisp contrast."
    - Preview colors: canvas `#0a0a0a`, panel `#171717`, raised `#141414`, border `#2a2a2a`, text `#fafafa`, muted `#888888`, accent `#ffffff`, success `#10b981`, warning `#f59e0b`, danger `#ef4444`.
- **Theme CSS Tokens (`theme.css`)**:
  - Add `:root[data-theme='simple']` block mapping all CSS custom properties (`--bg`, `--bg-elevated`, `--bg-sunken`, `--text`, `--accent`, etc.).

## Visual specification

```css
:root[data-theme='simple'] {
  --bg: #0a0a0a;
  --bg-elevated: #171717;
  --bg-sunken: #030303;
  --bg-input: #141414;
  --bg-hover: rgba(255, 255, 255, 0.05);
  --bg-active: rgba(255, 255, 255, 0.09);
  --border: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.15);
  --text: #fafafa;
  --text-secondary: rgba(255, 255, 255, 0.65);
  --text-tertiary: rgba(255, 255, 255, 0.40);
  --danger: #ef4444;
  --accent: #ffffff;
  --accent-hover: #e6e6e6;
  --accent-contrast: #0a0a0a;
  --accent-soft: rgba(255, 255, 255, 0.12);
  --accent-border: rgba(255, 255, 255, 0.35);
  --caption-hover: rgba(255, 255, 255, 0.07);
  --shadow-panel: 0 8px 32px rgba(0, 0, 0, 0.7);
}
```

## Acceptance criteria

- `enableEasyMode` defaults to `false`.
- Toggling EasyMode in Settings -> Preview persists to app settings and updates the application state live via IPC.
- `simple` appears in the Themes gallery under Settings -> Appearance.
- Selecting `simple` theme sets `data-theme="simple"` on `<html>` and correctly applies the Orca palette tokens.
- Text contrast meets WCAG AA standards (> 4.5:1) across all text levels.
- Disabling EasyMode restores the standard sidebar with zero side-effects.

## Validation

- `npm run test:core`
- `npm run check-core-imports`
- `npm run check-types`
- E2E spec verifying toggle persistence and theme switching.

## Comments

All child tasks (TASK-375, TASK-376) are complete. The `enableEasyMode` settings contract, sanitizer, merge routines, core tests, renderer defaults, `simple` theme registration, `:root[data-theme='simple']` tokens, and Settings Preview toggle switch are implemented and verified.

## Description


## Dependencies


