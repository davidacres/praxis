# FX-BE-047 — PROJECT.md derived from the effective workflow

**Type:** Story  **Status:** Proposed  **Priority:** P2  **Depends on:** FX-BE-046

## Business or operational impact
`writeProjectSnapshot` opens `PROJECT.md` with the `wx` flag — written once at creation, `'retained'` forever after. Its `## Workflow` section is a snapshot of template defaults that nothing reconciles, which is how this repository came to advertise four columns its board cannot render.

## Scope
- `renderSnapshot` writes the **effective board workflow** (the same resolution chain `FolderService` uses), not the raw record stages, so the file cannot advertise an unreachable column.
- Regenerated when workflow, purpose or brief changes, instead of written once.
- Hand edits preserved: Praxis rewrites only its own generated sections, delimited by a marker, leaving human prose intact. A marker-less file — every file written before this story, including this repo's — is adopted by rewriting only the sections it already recognises.

## Acceptance criteria
- Changing a workflow updates `PROJECT.md`'s `## Workflow` section.
- User prose in `PROJECT.md` survives regeneration.
- A pre-existing `PROJECT.md` is adopted without losing content.
- This repo's own `PROJECT.md` ends up describing the workflow its board renders, verified by parsing it back.

## Validation
- `npm run check-types`
- `npm run test:desktop` (`projects.spec.ts`)

## Close when
`PROJECT.md` cannot drift from the board, because it is generated from it.
