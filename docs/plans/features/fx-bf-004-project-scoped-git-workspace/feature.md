---
**Status:** 📋 Proposed
**Created:** 2026-08-27T21:20:02.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-004
slug: project-scoped-git-workspace
title: Project-scoped Git workspace and repository onboarding
status: Done
owner: Electron desktop app
updated: 2026-09-03
issues: [docs/issues/features/fx-bf-004-project-scoped-git-workspace/feature-issues.md]
stories: [FX-BE-005]
validation: ["npm run frontend:build", "npm run electron:check-types", "npm run test:e2e --workspace @praxis/desktop-main -- e2e/gitGraph.spec.ts"]
---

# FX-BF-004: Project-scoped Git workspace and repository onboarding

## Project-scoped Git workspace and repository onboarding

## Outcome

Make Git Graph feel native to Praxis projects: Git tools appear in the context of a project working folder, repository state is checked before any Git command is attempted, and users get a clear next action when a folder is missing or Git has not been initialized.

## Scope

- Move Git Graph access from a global sidebar destination into the active project Git section and project actions.
- Resolve a project's working folder and classify it as unavailable, inaccessible, non-repository, or a valid repository/worktree.
- Provide friendly onboarding for choosing a folder, opening an existing repository, cloning, or explicitly initializing Git.
- Preserve the existing graph/diff workspace once a valid repository is available.
- Replace raw subprocess errors with safe, actionable UI messages and retry paths.

## Story map

- `FX-BE-005` — Project-scoped Git entry point and repository onboarding.

## Dependencies

- FX-BF-003 — Git integration with visual commit graph and diff workspace.
- Praxis project workspaceFolder and project-first navigation.

## Risks or open questions

- A folder may contain a nested repository or Git worktree metadata; discovery must use Git's repository root rather than only checking for `.git`.
- Initializing Git is a repository mutation and must require explicit confirmation.
- Folder selection and cloning need platform-safe dialogs and cancellation behavior.

## Close when

No Git Graph route invokes `git:open` without a validated project repository context; each empty/error state offers a safe next action; initialization is explicit and verified; and the packaged Electron project-to-graph flow passes at narrow and wide layouts.

## As built — shell revision (2026-09-03)

The graph view built its own third column for the commit inspector, so the app's
right pane sat empty on the `git` route while the inspector was squeezed into a
fixed 220–260px strip — and hidden outright below 1120px.

- The inspector now `createPortal`s into the shell's right pane, the same
  pattern the Workflow designer uses: `GitGraphPage` takes `auxSlot` and
  `onRequireAux`, and selecting a commit reveals the pane. It is resizable and
  collapsible like every other right pane, so the breakpoints that used to hide
  it are gone.
- Scoped to the **graph** view. `gitView === 'changes'` keeps the full centre
  width (`App.showAux` excludes it) — the diff workspace has its own file list
  and genuinely wants the room.
- The centre pane is ~380px narrower as a result, so the header, the toolbar,
  and the settings/compare panels reflow instead of overflowing: the header
  wraps and truncates the repository name, the toolbar caps at 38% height and
  scrolls, and the settings grid is `auto-fit`. The history column shrinks and
  scrolls horizontally rather than forcing the grid past its pane.
- `gitGraph.spec.ts`'s narrow-window test now collapses the right pane first,
  which is the affordance a real narrow window has.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


