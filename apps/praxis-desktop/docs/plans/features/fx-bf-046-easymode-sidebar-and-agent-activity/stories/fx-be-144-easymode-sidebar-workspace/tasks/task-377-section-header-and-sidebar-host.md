---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:25:00.000Z
**Type:** Task
**Priority:** High
id: TASK-377
title: "Create EasyModeSidebar host container and reusable SectionHeader component"
status: Complete
story: FX-BE-144
feature: FX-BF-046
updated: 2026-09-26
dependencies: [TASK-375]
---

# TASK-377: Create EasyModeSidebar host container and reusable SectionHeader component

## Goal

Provide the full-area sidebar container when `enableEasyMode` is enabled, suppressing the standard projects/sessions splitter, and implement the standard section header component with left title and right-aligned `+` action button.

## Dependencies

- TASK-375

## Execution track

- **Track C (Sidebar Framework)**: Unblocks Sessions list (`TASK-378`) and Automations section (`TASK-379`). Runs in parallel with Track B (`TASK-376`).

## Scope

- In `apps/praxis-desktop/renderer/src/components/sidebar/SectionHeader.tsx`:
  - Create reusable `SectionHeader` component displaying section title, count badge (optional), and right-aligned `+` button with accessible `aria-label` and tooltip.
- In `apps/praxis-desktop/renderer/src/components/sidebar/EasyModeSidebar.tsx`:
  - Create the root container occupying the full sidebar width and height (`display: flex; flex-direction: column; height: 100%`).
  - Wire section slots for Sessions and Automations.
- In `apps/praxis-desktop/renderer/src/components/sidebar/Sidebar.tsx` (or parent layout):
  - Read `settings.preview.enableEasyMode`.
  - When true, render `<EasyModeSidebar />` exclusively, bypassing `SidebarSplitter`, project tree, and board switcher.

## Acceptance criteria

- When `enableEasyMode` is false, standard sidebar behavior remains completely unchanged.
- When `enableEasyMode` is true, `EasyModeSidebar` occupies the entire sidebar panel.
- `SectionHeader` displays the section title on the left and a right-aligned `+` action button with proper tooltip and keyboard navigation.

## Validation

- `npm run check-types`
- `npm run check-core-imports`

## Description


## Comments

Implemented reusable `SectionHeader` in `apps/praxis-desktop/renderer/src/components/sidebar/SectionHeader.tsx` displaying title, optional count badge, and right-aligned `+` button with accessible `aria-label` and visible focus states. Implemented `EasyModeSidebar` host container in `apps/praxis-desktop/renderer/src/components/sidebar/EasyModeSidebar.tsx` with Slots for Sessions and Automations. Added base layout styles in `apps/praxis-desktop/renderer/src/theme.css`. Wired `enableEasyMode` check into `apps/praxis-desktop/renderer/src/app/App.tsx` to conditionally render `EasyModeSidebar` while preserving classic sidebar when disabled. Typecheck and core import guards verified clean.
