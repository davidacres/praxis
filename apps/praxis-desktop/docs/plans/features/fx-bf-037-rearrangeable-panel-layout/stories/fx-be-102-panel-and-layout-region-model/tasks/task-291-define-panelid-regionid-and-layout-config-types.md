---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-291
title: "Define PanelId, RegionId, and layout config types"
status: Proposed
story: FX-BE-102
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BE-102]
---

# TASK-291: Define PanelId, RegionId, and layout config types

## Objective

Add a `PanelId` union (`sidebar | main | aux | bottomPanel`, extensible), a `RegionId` union (`left | right | center | bottom`), and a `LayoutConfig` type (`Record<RegionId, PanelId>` or equivalent) to `@praxis/core`, plus a pure resolver function that maps a `LayoutConfig` to region contents.

## Implementation notes

- Keep the types in core (`packages/core/src/config` or similar) since both main and renderer need them, following the existing settings-type pattern.
- The resolver must be a pure function with no React/DOM dependency so it unit-tests cleanly in `test:core`.
- Do not import core values into the renderer at runtime — only types — per the renderer/core CommonJS boundary rule; mirror any renderer-side default in `settingsDefaults.ts` style if needed.
- Validate that a `LayoutConfig` always accounts for exactly the known `PanelId`s with no duplicates or omissions; an invalid config falls back to the default rather than crashing the shell.

## Acceptance criteria

- The behaviour is covered by deterministic unit tests in `packages/core`.
- Invalid or partial configs resolve to a safe default instead of throwing.
- Types are exported from `@praxis/core`'s public entry point.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:core` for the new resolver tests and `npm run check-types` across workspaces.

## Description


## Dependencies



## Comments
