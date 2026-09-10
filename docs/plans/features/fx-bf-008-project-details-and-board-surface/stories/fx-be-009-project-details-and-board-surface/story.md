---
**Status:** 📋 Proposed
**Created:** 2026-09-06T13:13:26.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-009
title: Project-details inspector, theme-aware detail panes, per-board plain background, sidebar board removal, no-boards centre state
status: Done
feature: FX-BF-008
updated: 2026-09-06
commits: []
dependencies: [FX-BF-005]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# Project-details inspector and board surface controls

## Note on how this story file came to exist

`FX-BF-008` was planned and delivered as a **single story covering the whole
feature** — the story was tracked in `docs/PLAN_MAP.md` but never given a file,
so it did not appear on Praxis's own board. Backfilled on 2026-09-06.

**The authoritative scope is [the feature file](../../feature.md)** — it carries
the full per-section specification (identity header, brief completion meter,
workspace section, planning sources, board surface controls). This file exists
so the story is a real item on the board and is not duplicated here.

No implementing commits are recorded: the work predates the current tracker and
only `4c14345` ("capture current Praxis implementation baseline") touches the
feature folder, so `commits:` is deliberately left empty rather than guessed at.

## User or operational impact

The right pane was not a coherent detail surface: selecting a project gave a
second navigation panel rather than an inspector, ticket details painted an
opaque fill instead of inheriting the active theme and surface pack, a board
whose material hurt legibility had no escape hatch, boards could not be removed
from the sidebar, and an empty workspace showed an inert composer instead of
guiding the user to create a board.

## Scope

Five threads, specified in full in the feature file:

1. **Project-details inspector** (`ProjectHome`) — identity header with inline
   edit, status chips, a brief completion meter over a per-field checklist, a
   workspace section, and planning sources with link/unlink.
2. **Theme-aware detail panes** — the right pane inherits the active theme and
   surface pack rather than painting an opaque fill.
3. **Per-board plain background** — a board-settings toggle that suppresses
   only the surface material and persists across relaunch.
4. **Sidebar board removal** — every connection-backed board can be removed
   with the correct backend action for its type; removing the open board is safe.
5. **No-boards centre state** — an empty workspace guides the user to create a
   board with a working action.

## Acceptance criteria — verified

Taken from the feature's own close-when list:

- The right pane renders the inspector for a selected project and theme-aware
  ticket details for a selected work item; both inherit the active theme /
  surface pack.
- Board settings expose a per-board **Plain background** toggle that persists
  across relaunch and suppresses only the surface material.
- Every connection-backed board in the sidebar can be removed with the correct
  backend action per board type; removing the open board is safe.
- An empty workspace shows the "No boards" centre state with a working
  **Create board** action.

## Tests

`npm run check-types`, `npm run test:core`, and the desktop e2e suites for
`projects`, `userWorkspace`, `connectionsManager`, `boardPrefs`, `app`,
`issueDetail`, and `surfacePacks`.

## Description


## Dependencies



## Comments


