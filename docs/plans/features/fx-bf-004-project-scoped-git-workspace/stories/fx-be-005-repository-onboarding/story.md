---
**Status:** 📋 Proposed
**Created:** 2026-09-06T13:41:43.983Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-005
title: Project-scoped Git entry point and repository onboarding
status: complete
feature: FX-BF-004
issue: docs/issues/features/fx-bf-004-project-scoped-git-workspace/stories/fx-be-005-repository-onboarding/issue.md
updated: 2026-08-27
tasks: [TASK-044, TASK-045, TASK-046, TASK-047, TASK-048]
dependencies: [FX-BF-003]
validation:
  - npm run frontend:build
  - npm run electron:check-types
  - npm run test:e2e --workspace @praxis/desktop-main -- e2e/gitGraph.spec.ts
---

# Project-scoped Git entry point and repository onboarding

## Project-scoped Git entry point and repository onboarding

Parent feature folder: `fx-bf-004-project-scoped-git-workspace`

## User or operational impact

Users can understand why Git tools are unavailable and reach a working graph without seeing Git command-line failures or guessing which folder Praxis is using.

## Scope

- Project Git navigation and active-project context.
- Typed repository preflight and user-safe error states.
- Open, clone, and initialize actions with explicit confirmation.
- Integration with the existing Git Graph and diff workspace.

## Acceptance criteria

- A folderless project does not expose an active Git Graph; its project Git section explains that a working folder is required.
- A project folder that is not a repository shows a friendly state with `Initialize Git`, `Choose another folder`, and `Cancel`/back navigation.
- A valid repository opens the existing Git Graph without an intermediate error screen.
- Missing, inaccessible, bare, and worktree cases are classified distinctly enough to provide an actionable message.
- Initialization never happens implicitly; confirmation explains the `.git` directory mutation and the target path.
- Raw `git:open`/`rev-parse` stderr is not rendered as the primary user-facing error.
- E2E coverage verifies folderless, non-repository, initialized, and valid-repository project flows in packaged Electron.

## Task list

- `TASK-044` — Define project Git context and typed repository preflight contract.
- `TASK-045` — Implement Electron repository classification and safe initialization/open actions.
- `TASK-046` — Add project-scoped Git navigation and onboarding states.
- `TASK-047` — Integrate onboarding with Graph/diff loading and friendly error recovery.
- `TASK-048` — Add packaged Electron, accessibility, and responsive verification.

## Notes

Keep the existing graph/diff visual language. The new work owns entry-point/context and recovery UX, not another graph implementation. Prefer project `workspaceFolder` as the default context; a standalone folder chooser is a fallback, not a hidden global working directory.

## Close when

The project-first Git flow is usable by a non-expert from an empty project through repository initialization or opening the graph, with typed failures, explicit mutation confirmation, and green packaged Electron verification.

## Description


## Dependencies



## Comments


