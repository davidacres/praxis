---
**Created:** 2026-09-06T13:41:43.981Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-003
title: Desktop Git graph foundation and editor shell
status: complete
feature: FX-BF-003
---

# FX-BE-003: Desktop Git Graph Foundation And Editor Shell

**Status:** Complete
**Impact:** New Electron desktop page, IPC boundary, and Git read model
**Dependencies:** FX-BF-003
**Issue mirror:** [issue.md](../../../../../issues/features/fx-bf-003-git-visual-integration/stories/fx-be-003-git-graph-foundation/issue.md)

## Scope

Deliver the first read-only vertical slice: choose or detect a repository, load Git history through the system executable in Electron main, build a lane-aware graph, and present it in a polished React desktop page with commit inspection.

## Acceptance criteria

1. The Git Graph page opens for the selected repository or gives a recoverable explanation when no repository is available.
2. Local and remote branches, tags, `HEAD`, merge commits, branch tips, and parent/child relationships are visible.
3. Divergence and convergence are visually explicit and remain understandable when colors are disabled.
4. Selecting a commit opens message, author, dates, SHA, parents, children, changed files, and a diff action.
5. Branch focus, merge-only, date-range, zoom, pan, refresh, loading, empty, and error states work without losing the selected commit unexpectedly.
6. No mutating Git command is exposed until the read-only slice passes its validation gates.

## Validation

- `npm run check-types --workspace @praxis/core`
- `npm run check-types --workspace @praxis/desktop-main`
- `npm run check-types --workspace @praxis/desktop-renderer`
- Targeted unit tests for Git parsing and graph layout.
- Electron/manual check using a fixture repository with two branches and a merge.
- Focused visual check at narrow and wide editor sizes, with reduced motion and branch colors disabled.

## Latest evidence

- `npm run compile --workspace=@praxis/core` passed.
- `npm run check-types --workspace=@praxis/desktop-main` passed.
- `npm run check-types --workspace=@praxis/desktop-renderer` passed.
- `npm run build --workspace=@praxis/desktop-renderer` passed.
- `npx playwright test e2e/gitGraph.spec.ts --config=playwright.config.ts` passed.
- `npm run test:git --workspace=@praxis/desktop-main` passed, covering missing Git, non-repositories, worktrees, shallow history, and detached HEAD.
- Screenshot: `apps/praxis-desktop/main/output/playwright/git-graph.png`.
- Screenshot: `apps/praxis-desktop/main/output/playwright/git-graph-narrow-reduced-motion.png`.
- Core graph tests cover linear, split, merge, criss-cross, detached, multiple refs, and a 5,000-commit history benchmark.
- The Electron visual flow covers keyboard commit selection, settings persistence, merge filtering, zoom, working-tree changes, and narrow reduced-motion layout.
- The horizontal timeline mode and fetch interval setting are wired through the desktop settings and Git IPC layers.

## Description


## Dependencies



## Comments


