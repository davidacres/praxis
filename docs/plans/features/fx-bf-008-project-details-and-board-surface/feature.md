---
id: FX-BF-008
---

# FX-BF-008: Project-details inspector and board surface controls

**Created:** 2026-08-30T00:00:00.000Z
**Type:** Feature
**Status:** Done
**Owner:** Electron desktop app
**Priority:** P2

## Outcome

Make the right pane a coherent, theme-aware detail surface and give the board
an escape hatch when a surface material hurts legibility. Selecting a project
shows a compact project-details inspector (not a second navigation panel);
selecting a work item shows theme-aware ticket details; and every board can be
switched to a plain background from its own settings. The left sidebar's board
list becomes a place to remove boards, and an empty workspace guides the user
to create one instead of showing an inert composer.

## Scope

### Project-details inspector (right pane, `ProjectHome`)

- Identity header: project name, `KEY · TYPE · created` line, and an **Edit**
  affordance rendered as a pencil icon in the top-right of the header (it swaps
  to Cancel / Save in edit mode). No standalone "Open plans board" /
  "Open default board" button.
- Status chips under the header: repository state (`Git repo` / `No repo` /
  `No folder`), default tool mode, and linked-board count.
- **Brief** section: a completion meter (`filled / total`, purpose included)
  over a checklist of every brief field — a check plus the value when filled,
  a muted label when empty. Edit mode expands to the full form (type, tools,
  per-field text). This is the canonical full-brief edit surface; it does not
  repeat the dashboard's north-star summary.
- **Workspace** section: folder icon, basename, full path, and detected
  languages / frameworks / manifests as tags. No folder → the existing attach
  flow.
- **Planning sources** section: linked boards as compact rows with a trash
  icon to remove each one from the project (`projects.unlinkBoard`), available
  for the local-plans `(Live)` board too; plus the "Link an existing board"
  picker.
- Sections are borderless and transparent: they carry no surface of their own
  and inherit whatever theme / surface-pack material the pane behind them
  paints. The retained-`PROJECT.md` notice is not shown here.

### Theme-aware ticket details (`.detail-panel`)

- The issue-detail pane is transparent instead of an opaque `--bg` fill, so the
  pane's themed surface shows through, matching the project-details view. The
  expanded reading mode keeps its own solid fill so long descriptions stay
  legible.

### Per-board plain background

- New optional per-board preference `BoardColumnPreferences.plainSurface`
  (core), persisted through the board preferences store.
- Board settings → **Appearance** → **Plain background** toggles it.
- When on, the board's pane drops the surface-pack material (texture,
  watermark, tint, glass, accent glow) and falls back to a flat elevated
  fill. The colour theme is untouched.

### Board lifecycle from the left sidebar

- The trash control on the sidebar **Boards** list shows for every
  connection-backed board (not only plan boards). Demo boards, which have no
  connection, stay non-removable.
- "Remove" is routed by backend: user-workspace boards are deleted
  (`userWorkspace.deleteBoard`); a live-folder board *is* its connection, so
  the connection is removed (`connection.remove`); a Jira / GitLab board is
  only tracked, so it is untracked (`connection.removeTrackedBoard`). Deleting
  the board that is currently open navigates away first.

### No-boards centre state

- When the workspace has no boards and none is selected, the centre pane shows
  a "No boards" empty state with a **Create board** button that opens the
  Connections screen, instead of the AI session composer.

## Story map

- `FX-BE-009` — Project-details inspector, theme-aware detail panes, per-board
  plain background, sidebar board removal, and the no-boards centre state.

## Dependencies

- `FX-BF-005` — Sidebar project, board, and Git navigation (the "intentional
  project summary" the centre pane was reserved for is realised here as the
  right-pane inspector).
- Surface packs / theming system (`theme.css`, `surfaces.css`,
  `--surface-*` tokens).
- `BoardColumnPreferences` and the board preferences store in
  `packages/core`.

## Close conditions

- The right pane renders the project-details inspector for a selected project
  and theme-aware ticket details for a selected work item; both inherit the
  active theme / surface pack rather than painting an opaque fill.
- Board settings expose a per-board **Plain background** toggle that persists
  across relaunch and suppresses only the surface material.
- Every connection-backed board in the sidebar list can be removed, with the
  correct backend action per board type, and removing the open board is safe.
- An empty workspace shows the "No boards" centre state with a working
  **Create board** action.
- `npm run check-types`, `npm run test:core`, and the desktop e2e suites for
  `projects`, `userWorkspace`, `connectionsManager`, `boardPrefs`, `app`,
  `issueDetail`, and `surfacePacks` pass.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-009 | Story | Project-details inspector, theme-aware detail panes, per-board plain background, sidebar board removal, no-boards centre state | Complete |


## Comments


