---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-294
title: "Build a generic PanelShell component"
status: Proposed
story: FX-BE-103
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BE-103]
---

# TASK-294: Build a generic PanelShell component

## Objective

Create a `PanelShell` component in `renderer/src/ui/` (a genuinely cross-cutting primitive) providing a title bar with panel name/icon, a drag handle for TASK-3xx drag-and-drop work, and a collapse/expand control, wrapping arbitrary child content.

## Implementation notes

- Follow the surface-pack material recipe for any new chrome: fill with the `color-mix` panel tint, `box-shadow: var(--surface-accent-glow), <elevation shadow>`, `backdrop-filter: var(--surface-backdrop)`, boosted `border-radius`, so it is not a flat untextured box under an active pack.
- The drag handle must not remove the global `:focus-visible` ring; add emphasis on focus rather than an `outline: none` reset.
- Do not hard-code panel titles here — accept a title/icon via props so TASK-295's adapters supply their own.
- Keep this component free of any layout/region logic; it only renders chrome around children.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results (e.g. missing title falls back sensibly).
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` for a new `PanelShell` component spec and `e2e/keyboardFocus.spec.ts` to confirm the focus ring still paints on the new drag handle.

## Description


## Dependencies



## Comments
