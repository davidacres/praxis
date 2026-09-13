---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-293
title: "Provide a default layout config and reset-to-default path"
status: Proposed
story: FX-BE-102
feature: FX-BF-037
updated: 2026-09-13
dependencies: [TASK-291, TASK-292]
---

# TASK-293: Provide a default layout config and reset-to-default path

## Objective

Ship a `DEFAULT_LAYOUT_CONFIG` matching today's fixed arrangement (sidebar left, main center, aux right, bottom panel bottom) and a "Reset layout to default" action reachable from Settings, so a user who rearranges panels into an unusable state can always recover.

## Implementation notes

- The default must be a named export in core so it can be imported for both the shell's fallback and the reset action's target value, matching the resolver's fallback behaviour from TASK-291.
- Reset should be a single, discoverable, in-app action (Settings page control), not a hidden dev-only escape hatch, consistent with this app's themed-UI-only rule for user-facing actions.
- Follow existing dialog conventions (`useDialogs()`), no `window.confirm`, if the reset action should confirm before applying.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results (an unrecoverable layout is never possible).
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run the focused core package tests plus an e2e check that the Settings reset control restores the default arrangement.

## Description


## Dependencies



## Comments
