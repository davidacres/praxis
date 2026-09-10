---
**Status:** 📋 Proposed
**Created:** 2026-09-06T14:40:37.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-046
title: Editing a project's workflow
status: Done
feature: FX-BF-019
updated: 2026-09-06
commits: []
dependencies: [FX-BE-045]
validation: [npm run check-types, npm run test:desktop, npm run test:desktop:themes]
---

# Editing a project's workflow

## Why

This is the root cause, not a convenience. The workflow is set once in the New
Project wizard and there is no editor anywhere: `ProjectWorkspace` only reads
it for a progress meter. A workflow that cannot be changed is a workflow that
will become wrong — this repository is the proof.

## Scope

- A workflow section in the project-details inspector (`ProjectHome`, alongside
  the existing Brief and Planning-sources sections — the established edit
  surface, not a new one): reorder, rename, add and remove stages, each with
  its category.
- Saving writes the project record and, when the project's board is
  folder-backed, calls `syncBoardConfigToFolder()` so the workflow lands in
  `board.praxis.json` next to the plans.
- Guardrails, surfaced before save: renaming a stage that tickets currently
  occupy explains how many will be re-resolved; removing such a stage requires
  choosing where its tickets go.
- Validation from `FX-BE-043` is enforced in the UI with named reasons rather
  than a disabled button with no explanation.

## Acceptance criteria

- A project's workflow can be edited after creation and the board's columns
  change to match.
- For a folder-backed board the change is visible in `board.praxis.json` and
  survives a relaunch.
- Removing an occupied stage cannot silently orphan its tickets.

## Validation

- `npm run check-types`
- `npm run test:desktop` — a new `projectWorkflow.spec.ts`
- `npm run test:desktop:themes` — the inspector's new section in the gallery

## Description


## Dependencies



## Comments


