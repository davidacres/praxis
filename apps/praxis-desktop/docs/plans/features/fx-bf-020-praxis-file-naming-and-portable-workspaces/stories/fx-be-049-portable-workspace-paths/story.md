---
**Status:** 📋 Proposed
**Created:** 2026-09-10T10:48:08.224Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-049
title: Workspace files store in-tree paths relative to themselves
status: Done
feature: FX-BF-020
updated: 2026-09-06
commits: []
dependencies: []
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# Workspace files store in-tree paths relative to themselves

## Why

A workspace file is explicitly designed to be committed — `toWorkspaceFile`
strips credentials so that a token "must not be the thing that leaks when a
workspace file is committed to a repo". But it stores `workspaceFolder` and
folder-connection `roots` as absolute paths, so the file resolves on exactly one
machine. Sharing it is the stated purpose and it does not survive the trip.

## Scope

- On write, a path **inside the workspace file's own directory tree** is stored
  relative to the file (`./`-prefixed, POSIX separators so a file written on
  macOS opens on Windows).
- A path **outside** that tree stays absolute — there is nothing sensible to
  make it relative to, and silently rewriting it would be worse than honest.
  This is a functional distinction, not a compatibility one.
- On read, a relative path resolves against the file's own directory, so moving
  or cloning the tree just works.
- Applies to `ProjectRecord.workspaceFolder` and folder-connection
  `settings.roots`.

## Acceptance criteria

- A workspace file saved beside its project stores `./` paths, and opening the
  same tree from a different absolute location resolves every folder.
- A folder outside the file's tree round-trips unchanged as an absolute path.
- Separators are POSIX in the file regardless of host.
- This repository's `praxis-code.workspace.praxis.json` no longer contains
  `/Users/daveacres`.

## Validation

- `npm run check-types`
- `npm run test:core` — path shaping is pure and unit-tested both directions
- `npm run test:desktop` (`workspaceFile.spec.ts`, `savedWorkspaces.spec.ts`)

## Description


## Dependencies



## Comments


