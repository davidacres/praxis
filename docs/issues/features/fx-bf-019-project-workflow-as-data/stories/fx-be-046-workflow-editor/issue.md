# FX-BE-046 — Editing a project's workflow

**Type:** Story  **Status:** Proposed  **Priority:** P1  **Depends on:** FX-BE-045

## Business or operational impact
This is the root cause, not a convenience. The workflow is set once in the New Project wizard and there is no editor anywhere — `ProjectWorkspace` only reads it for a progress meter. A workflow that cannot be changed is a workflow that will become wrong; this repository is the proof, stamped `software` on 2026-08-31 and never using one of those stages.

## Scope
- A workflow section in the project-details inspector (`ProjectHome`) — the established edit surface beside Brief and Planning sources, not a new one. Reorder, rename, add, remove; each stage with its category.
- Saving writes the project record and, for a folder-backed board, calls `syncBoardConfigToFolder()`.
- Guardrails surfaced before save: renaming an occupied stage says how many tickets re-resolve; removing one requires choosing where its tickets go.
- `FX-BE-043`'s validation is enforced with named reasons, not a disabled button.

## Acceptance criteria
- A workflow can be edited after creation and the board's columns follow.
- For a folder-backed board the change lands in `board.praxis.json` and survives relaunch.
- Removing an occupied stage cannot silently orphan its tickets.

## Validation
- `npm run check-types`
- `npm run test:desktop` (`projectWorkflow.spec.ts`)
- `npm run test:desktop:themes`

## Close when
A team can change how they work without recreating the project.
