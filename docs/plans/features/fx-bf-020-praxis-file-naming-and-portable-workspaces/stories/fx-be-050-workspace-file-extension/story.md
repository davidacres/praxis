---
**Status:** 📋 Proposed
**Created:** 2026-09-10T10:48:08.225Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-050
title: A workspace file is .praxis.json, not .praxis
status: complete
feature: FX-BF-020
updated: 2026-09-06
commits: []
dependencies: [FX-BE-048, FX-BE-049]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# A workspace file is .praxis.json, not .praxis

## Why

FX-BE-048 recorded two naming forms and justified the bespoke `.praxis`
extension on the grounds that a workspace file is "opened with Praxis". That
justification did not survive being checked:

- there is **no `fileAssociations` entry** in the electron-builder config;
- there is **no `open-file` handler** in the main process.

Double-clicking a `.praxis` file has never opened anything. The extension was
buying only the save/open dialog filter, which works identically with any
pattern — while costing editor highlighting, GitHub rendering and JSON schema
association.

And FX-BE-049 changed what the file is *for*. Stripping credentials and storing
relative paths exist so a workspace can be **committed**; it is now read,
diffed and reviewed far more often than it is opened. That tips the balance
decisively.

## Scope

- `PRAXIS_WORKSPACE_FILE_SUFFIX` → `.workspace.praxis.json`,
  `PRAXIS_WORKSPACE_FILE_EXTENSION` → `json` (the dialog filter matches the
  final segment only).
- The naming rule in AGENTS.md collapses from two forms to one:
  **`<name>.praxis.<ext>`**, real extension last.
- This repository's own file renamed via `git mv`.
- Every reference updated — source, e2e, README, feature-parity doc, plans.

If double-click-to-open is built later, the association registers against
`.praxis.json` just as easily. That is the same trade VS Code makes for
`.code-workspace`, which GitHub also declines to highlight.

## Acceptance criteria

- A saved workspace is written as `<slug>.workspace.praxis.json`.
- Both dialogs filter on it and a saved file round-trips.
- No reference to a bare `.workspace.praxis` remains anywhere.

## Validation

- `npm run check-types`
- `npm run test:core`
- `npm run test:desktop` (`workspaceFile.spec.ts`, `savedWorkspaces.spec.ts`)

## Description


## Dependencies



## Comments


