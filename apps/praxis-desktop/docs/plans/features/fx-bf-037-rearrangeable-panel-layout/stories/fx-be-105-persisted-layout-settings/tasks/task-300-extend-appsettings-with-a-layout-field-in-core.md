---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-300
title: "Extend AppSettings with a layout field in core"
status: Proposed
story: FX-BE-105
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BE-105]
---

# TASK-300: Extend AppSettings with a layout field in core

## Objective

Add a `layout: { regions: LayoutConfig; sizes: Partial<Record<RegionId, number>> }` field to `AppSettings` in `packages/core/src/config/appSettings.ts`, with migration support in `sanitizeAppSettings` for documents written before this field existed.

## Implementation notes

- Follow the existing settings pattern: default value in `DEFAULT_APP_SETTINGS`, validated/sanitized on read via `sanitizeAppSettings`, merged via `mergeAppSettings`.
- An invalid or partial `layout` value (e.g. referencing an unknown `PanelId`) must sanitize to the default rather than being written back verbatim or crashing settings load.
- Do not couple this field's shape to any specific drag-and-drop implementation detail — it should describe layout state only.

## Acceptance criteria

- The behaviour is covered by deterministic unit tests in `packages/core`.
- Invalid, unsupported, stale and failure paths produce useful user-visible results (sanitizes to default).
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:core` for new `appSettings` migration/sanitization tests.

## Description


## Dependencies



## Comments
