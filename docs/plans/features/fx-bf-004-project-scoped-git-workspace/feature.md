---
**Status:** 📋 Proposed
**Created:** 2026-08-30T01:28:58.133Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-004
slug: project-scoped-git-workspace
title: Project-scoped Git workspace and repository onboarding
status: complete
owner: Electron desktop app
updated: 2026-08-27
issues: [docs/issues/features/fx-bf-004-project-scoped-git-workspace/feature-issues.md]
stories: [FX-BE-005]
validation: ["npm run frontend:build", "npm run electron:check-types", "npm run test:e2e --workspace @praxis/desktop-main -- e2e/gitGraph.spec.ts"]
---

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

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


