# FX-BE-006 — Sidebar-owned project, board, and Git tree

**Type:** Feature story
**Status:** Complete
**Priority:** P1
**Depends on:** FX-BF-004

## Business or operational impact

Praxis needs one obvious navigation model: projects and boards live in the sidebar, and repository tools are reached from the project tree rather than duplicated in the center pane.

## Scope

- Projects → Boards and Git sidebar hierarchy.
- Git tool label and repository status language.
- Center-pane simplification.
- Right-sidebar project details.

## Delivery notes

- Use `Git` as the visible label; use `Repository` in status copy.
- Keep Graph/Changes/Conflicts routes tied to the active project workspace.
- Preserve unlinked external boards outside project ownership.

## Acceptance criteria

- Selecting a project reveals its Boards and Git context in the sidebar.
- The center pane does not duplicate Boards/Git navigation cards.
- Project properties are shown in the right sidebar.
- Folderless and non-repository states remain clear and safe.

## Validation

- `npm run frontend:build`
- `npm run electron:check-types`
- `npm run electron:copy-renderer`
- `npm run test:e2e --workspace @ticket-manager/electron-app -- e2e/projects.spec.ts`

## Close when

The packaged desktop app makes the sidebar the authoritative path for project → board and project → Git navigation at supported desktop widths.
