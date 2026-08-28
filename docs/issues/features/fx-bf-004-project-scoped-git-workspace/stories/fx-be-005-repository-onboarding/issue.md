# FX-BE-005 — Project-scoped Git entry point and repository onboarding

**Type:** Feature story
**Status:** Complete
**Priority:** P1
**Depends on:** FX-BF-003

## Business or operational impact

Praxis users should reach Git history and diffs through a meaningful project workspace, without encountering raw command-line failures or accidentally operating on the wrong folder.

## Scope

- Project-owned Git navigation.
- Typed repository preflight and safe initialization.
- Folderless, non-repository, valid-repository, worktree, and recovery states.
- Integration with the existing Git Graph and diff workspace.

## Delivery notes

- Use the active project's `workspaceFolder` as the default repository context.
- Keep folder selection as an explicit fallback.
- Require confirmation before creating `.git`.

## Acceptance criteria

- Folderless projects explain that Git requires a working folder.
- Non-repository folders offer explicit Initialize Git and Choose another folder actions.
- Valid repositories open Graph/diff without raw `rev-parse` errors.
- No Git mutation happens implicitly.

## Validation

- `npm run frontend:build`
- `npm run electron:check-types`
- `npm run electron:copy-renderer`
- `npm run test:e2e --workspace @praxis/desktop-main -- e2e/gitGraph.spec.ts`

## Close when

The packaged Electron app supports a clear, project-first path from no folder to initialized/open repository and safely recovers from invalid repository contexts.
