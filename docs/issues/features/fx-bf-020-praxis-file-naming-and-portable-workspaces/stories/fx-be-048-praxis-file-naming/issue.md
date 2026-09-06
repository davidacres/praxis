# FX-BE-048 — A single naming rule for Praxis files

**Type:** Story  **Status:** Complete  **Priority:** P2  **Depends on:** —

## Business or operational impact
`PROJECT.md` is generic enough to collide with a file a repository already has, and since FX-BE-047 Praxis only rewrites a file carrying its own markers — so a repo with its own `PROJECT.md` got **no Praxis project file at all**, silently.

## Scope
- `PROJECT.md` → `project.praxis.md`, matching `board.praxis.json`.
- One exported `PROJECT_FILE_NAME` constant instead of scattered literals.
- The rule in AGENTS.md: opened by Praxis → `.praxis`; read by tooling → `.praxis.<ext>`.

## Acceptance criteria
- A new folder-backed project writes `project.praxis.md`.
- No `'PROJECT.md'` literal remains in source.

## Close when
Every file Praxis writes into a user's folder carries `praxis` in its name.
