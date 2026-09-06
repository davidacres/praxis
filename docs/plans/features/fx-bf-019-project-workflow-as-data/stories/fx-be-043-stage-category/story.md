---
**Status:** 📋 Proposed
**Created:** 2026-09-06T14:40:37.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-043
title: Stage category as a first-class field
status: complete
feature: FX-BF-019
updated: 2026-09-06
commits: []
dependencies: []
validation: [npm run check-types, npm run test:core]
---

# Stage category as a first-class field

## Why

`ProjectWorkflowStage` is `{ id, name }`. Without a category there is no way to
map a freeform status ("✅ Complete") onto an arbitrary workflow — which is the
single reason `FolderService` hard-codes its five statuses instead of reading
the project's. Every other status-aware part of the codebase already carries a
category; the project's own workflow type is the one that does not.

## Scope

- `ProjectWorkflowStage` gains `category: 'todo' | 'indeterminate' | 'done'` —
  Jira's vocabulary, already used by `folderService.STATUSES` and
  `jiraShape.statusCategoryRank`, so no new concept enters the codebase.
- `projectTemplates.STAGE_NAMES` becomes stage *objects* carrying a category
  for all four project types (software, product, research, experiment).
- `projectStore` validation extends: at least one `todo` and exactly one
  terminal `done` stage, on top of the existing "≥ 2 stages, unique names".
- A migration for stored `ProjectRecord`s with category-less stages: resolve by
  name synonym first, then by position (first → `todo`, last → `done`, the rest
  → `indeterminate`). Runs in the store's normalizer, so a record repairs on
  read rather than needing a one-shot script.

## Acceptance criteria

- Every shipped template's stages carry a category, and the terminal stage of
  each is `done`.
- A `ProjectRecord` written before this story loads with sensible categories
  and is not rejected.
- A workflow with no `done` stage, or with two, is refused at save time with a
  named reason.

## Validation

- `npm run check-types`
- `npm run test:core` — new cases in `projectService.test.ts` for the migration
  and the validation rules.

## Description


## Dependencies



## Comments


