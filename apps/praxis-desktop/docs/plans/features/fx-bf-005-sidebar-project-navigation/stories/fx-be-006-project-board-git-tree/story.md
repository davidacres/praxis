---
**Status:** ✅ Complete
**Created:** 2026-08-27T21:20:02.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-006
title: Sidebar-owned project, board, and Git tree
status: Done
feature: FX-BF-005
issue: docs/issues/features/fx-bf-005-sidebar-project-navigation/stories/fx-be-006-project-board-git-tree/issue.md
updated: 2026-10-10
tasks: [TASK-049, TASK-050, TASK-051, TASK-052]
dependencies: [FX-BF-004]
validation:
  - npm run frontend:build
  - npm run electron:check-types
  - npm run electron:copy-renderer
  - npm run test:e2e --workspace @praxis/desktop-main -- e2e/projects.spec.ts
---

# Sidebar-owned project, board, and Git tree

## Sidebar-owned project, board, and Git tree

Parent feature folder: `fx-bf-005-sidebar-project-navigation`

## User or operational impact

Users can understand where work belongs and reach boards or Git tools from one consistent tree, without scanning the main content for duplicate navigation cards.

## Scope

- Sidebar hierarchy and project expansion behavior.
- Project-owned board and Git child nodes.
- Center-pane simplification and right-sidebar project details.
- Folderless and non-repository affordances.

## Acceptance criteria

- The left sidebar presents Projects and Boards as the primary navigation areas.
- Expanding a project reveals its Boards group and a Git group/row in the same project context.
- `Git` is the visible tool label; `Repository` is used for explanatory status and path copy.
- Clicking a project selects the project context; its editable properties remain in the right sidebar.
- The center pane does not repeat board or Git navigation cards.
- A folderless project shows Git as disabled/setup-needed and does not invoke Git IPC.
- A project workspace with no repository opens the existing onboarding flow from its Git row.
- External boards remain outside project-owned board trees unless explicitly linked.

## Task list

- `TASK-049` — Refactor sidebar hierarchy for project-owned Boards and Git.
- `TASK-050` — Replace center project navigation cards with focused project summary.
- `TASK-051` — Connect Git child actions to Graph, Changes, and Conflict contexts.
- `TASK-052` — Verify navigation semantics, accessibility, responsive layout, and migration snapshots.

## Notes

Do not rename the underlying Git feature or repository contracts. This story changes information architecture and route entry points while reusing FX-BF-004 preflight and onboarding behavior.

## Close when

The sidebar is the authoritative project/board/Git navigation surface and the packaged app demonstrates an unambiguous project → board or project → Git path at desktop and narrow widths.

## Description


## Dependencies



## Comments

**2026-10-10:** Closed during backlog review: the work is implemented in the shipped code (renderer, main and core) and the parent feature's 'As built' notes; the ticket's status had not been rolled up.
