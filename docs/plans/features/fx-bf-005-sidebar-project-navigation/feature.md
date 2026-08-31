---
**Status:** 📋 Proposed
**Created:** 2026-08-30T01:28:58.134Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-005
slug: sidebar-project-navigation
title: Sidebar project, board, and Git navigation
status: complete
owner: Electron desktop app
updated: 2026-08-27
issues: [docs/issues/features/fx-bf-005-sidebar-project-navigation/feature-issues.md]
stories: [FX-BE-006]
validation: ["npm run frontend:build", "npm run electron:check-types", "npm run test:e2e --workspace @praxis/desktop-main -- e2e/projects.spec.ts"]
---

## Sidebar project, board, and Git navigation

## Outcome

Make the Praxis sidebar the single source of navigation context for projects, their boards, and repository tools. Selecting a project should reveal its board and Git tree while the center pane stays focused on the selected work surface rather than duplicating navigation cards.

## Scope

- Keep Projects and Boards as the primary left-sidebar information architecture.
- Render each project's boards beneath the project node and render its repository tools beneath the same project context.
- Remove duplicate board/Git navigation cards from the project center pane; the center pane is reserved for the selected board, graph, diff, or an intentional project summary.
- Use **Git** for the sidebar label because it is short, familiar, and names the tool area; use **Repository** in explanatory copy and path/status metadata.
- Keep repository onboarding states accessible from the project Git node when a workspace exists but is not initialized.
- Preserve external/unlinked boards in the existing Boards/Connections area rather than attaching them to the wrong project.

## Proposed tree

```text
Projects
└── Customer Portal
    ├── Boards
    │   ├── Customer Portal Board
    │   └── Linked board
    └── Git
        ├── Graph
        ├── Changes
        └── Conflicts (when present)
Boards
└── External and unlinked boards
```

The visible label should be `Git`, not `Repo`. `Repository` remains the clearer term for status copy such as “Repository not initialized” and “Repository root”.

## Story map

- `FX-BE-006` — Sidebar-owned project, board, and Git tree.

## Dependencies

- FX-BF-004 — Project-scoped Git workspace and repository onboarding.
- Existing project-first board ownership and linked-board behavior.

## Risks or open questions

- A project with no workspace can show a disabled Git row with “Attach a workspace folder” guidance, but must not offer Graph actions.
- A repository can have multiple useful surfaces; keep Graph as the default child and make Changes/Conflicts contextual rather than cluttering every project.
- The center pane may still show a compact project summary, but it must not duplicate the sidebar tree.

## Close when

Project selection produces a clear sidebar tree of Projects → Boards and Git, the center pane no longer duplicates those navigation choices, folderless/non-repository states remain actionable, and project navigation plus Git Graph/diff flows pass packaged Electron verification.

## Follow-on

The "intentional project summary" this feature reserves the center pane for is
realised in **FX-BF-008** as a theme-aware project-details inspector in the
right pane (identity header with a pencil Edit action, status chips, a brief
completion checklist, workspace stack tags, and planning-source management).
FX-BF-008 also adds board removal from the sidebar **Boards** list and a
"No boards" center state.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


