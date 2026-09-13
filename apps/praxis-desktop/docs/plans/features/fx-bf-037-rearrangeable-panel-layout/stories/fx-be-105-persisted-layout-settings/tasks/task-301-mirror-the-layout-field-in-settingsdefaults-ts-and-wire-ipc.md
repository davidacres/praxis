---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-301
title: "Mirror the layout field in settingsDefaults.ts and wire IPC"
status: Proposed
story: FX-BE-105
feature: FX-BF-037
updated: 2026-09-13
dependencies: [TASK-300]
---

# TASK-301: Mirror the layout field in settingsDefaults.ts and wire IPC

## Objective

Add the same `layout` default to `apps/praxis-desktop/renderer/src/settings/settingsDefaults.ts` (the hand-maintained browser-safe mirror of core's `DEFAULT_APP_SETTINGS`), and confirm the existing `settings.get`/`settings.set`/`settings.onChanged` IPC round-trips it correctly.

## Implementation notes

- This is the exact drift risk this repo's conventions call out explicitly: forgetting this mirror update leaves the Settings page silently out of sync with what the main process sees. Do not import the core value at runtime into the renderer — duplicate the literal default here.
- No new IPC channel should be needed; `layout` rides the existing whole-settings-document channel.
- Verify `npm run check-core-imports` still passes after this change (it runs before `check-types`/`build` and specifically guards against a value import from `@praxis/core` in the renderer).

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run check-core-imports`, `npm run check-types`, and `npm run build` for the renderer workspace to confirm the mirror doesn't reintroduce a core value import.

## Description


## Dependencies



## Comments
