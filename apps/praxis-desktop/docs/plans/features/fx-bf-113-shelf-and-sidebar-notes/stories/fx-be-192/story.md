---
**Status:** 📋 Proposed
**Created:** 2026-10-31T02:46:10.662Z
**Type:** Story
**Priority:** Medium
id: FX-BE-192
type: Story
status: To Do
---

# FX-BE-192: Verify notes journeys and unchanged shelf geometry

## Goal

Prove behaviour and actual app appearance before delivery.

## Acceptance criteria

- Add focused store/IPC tests and E2E journeys for capture on both surfaces, linked edits, ungrouping, deletion, project isolation, restart, autosave errors and explicit single/group send. Assert no provider calls on save/group/open/cancel. Add rail geometry and workspace-inset assertions against the pre-change baseline. Keep pointer/hover/screenshot cases out of smoke specs.
- Build core, renderer, copy renderer, and desktop; run project type/import guards, focused notes tests and npm run test:desktop. Run affected theme/surface checks. Launch the app and manually exercise shelf creation, note capture, sidebar groups and session send with keyboard and pointer. Inspect screenshots in light/dark, material surfaces, supported scales and narrow windows; verify 14px at standard scale and unchanged allocation elsewhere. Preserve useful evidence and report failures and unrun checks separately.

## Dependencies

FX-BE-191

## Description


## Comments
