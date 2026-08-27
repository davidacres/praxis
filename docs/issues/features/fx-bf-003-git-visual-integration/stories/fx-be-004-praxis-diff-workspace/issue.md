# FX-BE-004 — Praxis Diff Workspace And Safe Git Workflows

**Type:** Story
**Status:** Complete
**Priority:** P0
**Depends on:** FX-BE-003

## Business or operational impact

Praxis users can understand and act on changes without reading raw Git output or leaving the desktop app for routine comparisons and conflict resolution.

## Scope

- Clean full-width diff modes for working, staged, commit, and ref comparisons.
- Granular safe actions, graph workflows, file history/blame, and three-way conflict resolution.

## Delivery notes

- [Live story plan](../../../../../../plans/features/fx-bf-003-git-visual-integration/stories/fx-be-004-praxis-diff-workspace/story.md)

## Acceptance criteria

- Diff UX is clean, easy, clear, responsive, keyboard-labelled, and never raw-patch-first.
- Typed Electron IPC owns Git execution and verified safety boundaries.

## Validation

- `npm run test --workspace @ticket-manager/core`
- `npm run test:git --workspace @ticket-manager/electron-app`
- `npm run check-types --workspace @ticket-manager/electron-app`
- `npm run build --workspace @ticket-manager/frontend`
- `npm run copy-renderer --workspace @ticket-manager/electron-app`
- `npm run test:e2e --workspace @ticket-manager/electron-app -- e2e/gitGraph.spec.ts`
- `git diff --check`

## Close when

All story acceptance criteria and visual gates are current and green.

Completed on 2026-08-27. The independently runnable Git slice is green; broader worktree failures are confined to unrelated legacy board-navigation and AI/session tests and are documented in the feature plan.
