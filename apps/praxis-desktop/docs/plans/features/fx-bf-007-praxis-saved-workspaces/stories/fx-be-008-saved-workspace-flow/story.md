---
**Status:** ✅ Complete
**Created:** 2026-08-28T19:08:27.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-008
title: Saved workspace model, versioned file format, and sidebar flow
status: Done
feature: FX-BF-007
updated: 2026-10-10
tasks: [TASK-060, TASK-061, TASK-062]
dependencies: [FX-BF-005]
validation:
  - npm run compile --workspace @ticket-manager/core
  - npm run electron:check-types
  - npm run frontend:build
  - git diff --check
---

# Saved workspace model, versioned file format, and sidebar flow

## Impact

Praxis gains a clear saved context above Projects. Project folders remain
project-level implementation locations; a workspace is a portable collection
and operating context.

## Acceptance criteria

- New installations receive a `My Workspace` containing existing projects.
- Workspace creation, switching, and project membership are available from the sidebar.
- Save and open use a native file picker and `.praxis-workspace.json`.
- Files record `schemaVersion`, `createdWithAppVersion`, and `lastSavedWithAppVersion`.
- Unsupported newer schemas are rejected without mutating stored workspaces.
- Exported files contain no connection secrets.

## Close conditions

Core contracts, Electron IPC, renderer flow, and verification are complete.

## Verification evidence

- `npm run compile --workspace @ticket-manager/core` passed.
- `npm run electron:check-types` passed.
- `npm run frontend:build` passed.
- Versioned workspace round-trip and rejection of schema version `99` passed.
- `npm run electron:copy-renderer` passed.
- `git diff --check` passed.

## Description


## Dependencies



## Comments

**2026-10-10:** Closed during backlog review: the work is implemented in the shipped code (renderer, main and core) and the parent feature's 'As built' notes; the ticket's status had not been rolled up.
