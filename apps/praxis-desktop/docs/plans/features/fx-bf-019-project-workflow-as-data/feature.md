---
**Status:** ✅ Complete
**Created:** 2026-09-06T00:00:00.000Z
**Type:** Feature
**Priority:** High
id: FX-BF-019
slug: project-workflow-as-data
title: A project's workflow is data, authored once and rendered by every backend
status: Done
owner: Electron desktop app
updated: 2026-10-10
issues: docs/issues/features/fx-bf-019-project-workflow-as-data/feature-issues.md
stories: [FX-BE-043, FX-BE-044, FX-BE-045, FX-BE-046, FX-BE-047]
validation: [npm run check-types, npm run test:core, npm run test:desktop, npm run test:desktop:themes]
---

# FX-BF-019: A project's workflow is data, authored once and rendered by every backend

## The defect

The New Project wizard asks the user to pick a project type, stamps that type's
workflow onto the `ProjectRecord`, writes it into `PROJECT.md`, and then — if
the project's board is folder-backed — **silently ignores it**. `FolderService`
declares its own five statuses as a TypeScript constant:

```ts
const STATUSES = [
  { name: 'Backlog',     category: 'todo' },
  { name: 'To Do',       category: 'todo' },
  { name: 'In Progress', category: 'indeterminate' },
  { name: 'Blocked',     category: 'indeterminate' },
  { name: 'Done',        category: 'done' }
];
```

A `software` project is stamped `Backlog → Requirements → Architecture →
Implementation → Verification → Done`. Four of those six columns can never
receive an item.

This repository is the proof: `PROJECT.md` was stamped on 2026-08-31 with the
`software` template and has never used a single one of those stages.

### Why it stays broken

The workflow is **frozen at creation and has no editor anywhere**:

- `NewProjectWizard` sets `workflowStages` once.
- `ProjectWorkspace` only *reads* them, for a progress meter.
- `writeProjectSnapshot` opens `PROJECT.md` with the `wx` flag — it returns
  `'retained'` if the file exists and never rewrites it.

A workflow that cannot be changed is a workflow that will become wrong.
Correcting the rendering without fixing the immutability only resets the clock
on the same bug.

## The correction

**A workflow is a property of the project — how the team works. It is authored
once, stays editable, and each backend *renders* it in its own storage.**

The framing that folder is "consistent with the other backends" is wrong. In
Jira the columns are the board configuration **a human wrote**; in GitHub they
are the `status: …` labels **a human created**. The backend is only where that
workflow is stored. Folder is the sole backend where no human can express it.

### The one missing primitive

```ts
ProjectWorkflowStage = { id, name }                 // today
ProjectWorkflowStage = { id, name, category }       // needed
//                       category: 'todo' | 'indeterminate' | 'done'
```

This is not a new invention — every other part of the codebase is already
category-aware and folder is the outlier:

| | already category-aware |
| --- | --- |
| `folderService.STATUSES` | carries `category`, but the list is hard-coded |
| `jiraShape.statusCategoryRank` | to do → 0, in progress → 1, done → 2 |
| `board/boardColumns.ts` | `buildBoardColumns(issues, { columnStatusOrder, rankStatus })` |

### Why category is load-bearing

The reason folder's columns are hard-coded is a real one:
`mapMarkdownStatusToPlanStatus` fuzzy-maps freeform prose — `✅ Complete`,
`🚧 In progress`, `📋 Proposed` — and you cannot fuzzy-infer "Architecture"
from "Proposed".

Give a stage a category and that objection dissolves. The mapper stops being a
**bucket assigner** and becomes a **resolver**:

```
resolveStatus(raw, stages)
  1. exact name match, case-insensitive   "Architecture" → Architecture
  2. synonym table                        "✅ Complete"   → category 'done'
  3. first stage of the resolved category → whatever "done" is called here
  4. fallback                             → first stage
```

Freeform prose keeps working against *any* declared workflow, because every
workflow has a todo / in-progress / done spine. Today's five stop being the
universe and become **the default workflow for a new project**.

## Scope

- **`FX-BE-043`** — `category` on `ProjectWorkflowStage`; templates declare it;
  a migration gives existing project records categories.
- **`FX-BE-044`** — `resolveStatus(raw, stages)` replaces
  `mapMarkdownStatusToPlanStatus`. Pure, unit-tested, with the current five as
  the default workflow.
- **`FX-BE-045`** — `board.praxis.json` gains `workflow`; `FolderService` reads
  its workflow instead of declaring it, building columns through the shared
  `buildBoardColumns`.
- **`FX-BE-046`** — a workflow editor, writing through to the project record
  and, for folder-backed boards, to `board.praxis.json`.
- **`FX-BE-047`** — `PROJECT.md` becomes derived from the effective workflow
  rather than a frozen snapshot.

`ProjectService` is deliberately untouched: it already builds
`columnStatusOrder` from `project.workflowStages` and is the reference for what
correct looks like.

## The non-regression gate

**A folder board with no declared workflow must be byte-identical to today.**
The default workflow is exactly the current five, in the current order, with
the current categories. `folder.spec.ts`, `folderMulti.spec.ts`,
`editIssue.spec.ts` and `newIssue.spec.ts` must pass unchanged before and
after every story in this feature.

## Dependencies

None hard. Touches `FX-BF-008`'s project model and the folder backend that
predates it.

## Close when

A user can state their project's workflow, change it later, and see the same
columns on the board whichever backend stores the tickets — and `PROJECT.md`
describes the workflow the board actually renders, because it is generated
from it rather than frozen beside it.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-043 | Story | Stage category as a first-class field | Complete |
| FX-BE-044 | Story | Resolve a freeform status against a declared workflow | Complete |
| FX-BE-045 | Story | Folder boards read their workflow instead of declaring it | Complete |
| FX-BE-046 | Story | Editing a project's workflow | Complete |
| FX-BE-047 | Story | PROJECT.md derived from the effective workflow | Complete |

## Description


## Comments

**2026-10-10:** Closed during backlog review: all items in this feature are delivered and recorded as Complete in its Items table / 'As built' notes; the header status had not been rolled up.
