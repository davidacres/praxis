---
**Status:** 📋 Proposed
**Created:** 2026-09-06T14:40:37.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-047
title: PROJECT.md derived from the effective workflow
status: Done
feature: FX-BF-019
updated: 2026-09-06
commits: []
dependencies: [FX-BE-046]
validation: [npm run check-types, npm run test:desktop]
---

# PROJECT.md derived from the effective workflow

## Why

`writeProjectSnapshot` opens `PROJECT.md` with the `wx` flag: it writes once at
creation and returns `'retained'` forever after. Its `## Workflow` section is
therefore a snapshot of the template defaults at creation time, which nothing
ever reconciles. That is how this repository ended up advertising four columns
its board cannot render.

## Scope

- `renderSnapshot` writes the **effective board workflow** — the same
  resolution chain `FolderService` uses — not the raw record stages, so the
  file cannot advertise an unreachable column.
- The snapshot is regenerated when the workflow, purpose or brief changes,
  instead of being written once.
- Hand edits are not clobbered: Praxis owns and rewrites only the sections it
  generates, delimited by a marker, and leaves anything a human added between
  or after them intact. A file with no markers (every file written before this
  story, including this repo's) is adopted on first regeneration by rewriting
  only the sections it already recognises.

## Acceptance criteria

- Changing a project's workflow updates `PROJECT.md`'s `## Workflow` section.
- Prose a user added to `PROJECT.md` survives a regeneration.
- A `PROJECT.md` written before this story is adopted without losing content.
- This repository's own `PROJECT.md` ends up describing the workflow its board
  actually renders — verified by parsing it back.

## Validation

- `npm run check-types`
- `npm run test:desktop` — `projects.spec.ts` extended for regeneration and for
  hand-edit preservation

## Description


## Dependencies



## Comments


