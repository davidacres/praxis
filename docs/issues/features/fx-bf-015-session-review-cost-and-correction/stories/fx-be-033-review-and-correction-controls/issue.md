# FX-BE-033 — Review and correction controls

**Type:** Story  **Status:** Complete  **Priority:** P1  **Depends on:** FX-BE-032

## Business or operational impact
Reviewing a session's changes used to mean scrolling collapsed tool rows; correcting a mistake meant discarding a whole file or asking the agent to fix its own work. Both are now a button in place.

## Scope
- A session's changeset reviewable in the working tree: diff, whole-file view, commit, discard.
- Per-hunk discard, reusing the diff workspace's own hunk-level primitive.
- A per-edit "Undo edit" control on the transcript's tool-call rows, refused once a later edit to the same path would be silently discarded.

## Acceptance criteria
- A finished session's changeset is fully reviewable and actionable without a separate diff workspace.
- Discarding one hunk leaves the file's other edits intact, verified on disk.
- Undoing an edit restores exact prior content and is refused once superseded.

## Validation
- `npm run check-types`
- `npm run test:core`
- `npm run test:desktop`

## Close when
A session's changeset is reviewable, committable, and correctable down to one hunk or one edit, entirely from the Sessions console.
