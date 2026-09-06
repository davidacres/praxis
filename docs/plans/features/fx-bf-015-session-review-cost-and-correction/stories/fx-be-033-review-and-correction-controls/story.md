---
**Status:** 📋 Proposed
**Created:** 2026-09-05T07:33:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-033
title: Review and correction controls
status: complete
feature: FX-BF-015
issue: docs/issues/features/fx-bf-015-session-review-cost-and-correction/stories/fx-be-033-review-and-correction-controls/issue.md
updated: 2026-09-05
commits: [d5ad6c4, 55b77a4, 5222d3e, ad30d9a, e73e301]
dependencies: [FX-BE-032]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# Review and correction controls

## User or operational impact

Reviewing what a session changed used to mean scrolling a chat transcript of
collapsed tool rows; correcting a mistake meant discarding a whole file or
asking the agent to fix its own work in a follow-up message. Both are now a
button in the place you're already looking.

## Scope

- `SessionChanges`: reads the session's own working tree (worktree when the
  session ran in one, otherwise its working folder) and shows every changed
  file with commit / discard-all / discard-one, independent of the transcript.
- A per-file diff, read via the same `git:getComparison` the full diff
  workspace uses.
- A per-file whole-file view (`git:getFileContent`, sandboxed via
  `safeRepositoryFile`, capped at 1MB, binary-detected) — not an editor, for
  reading a file the diff's hunk context doesn't fully show. Shares a small
  regex-based highlighter (`ui/codeHighlight.tsx`) with the diff workspace
  instead of duplicating it.
- Per-hunk discard in the diff pane, reusing the same `git:applyHunk` the diff
  workspace already uses for staging — so a bad hunk goes without losing the
  rest of the file's edits.
- A per-edit "Undo edit" button on the transcript's own tool-call rows,
  backed by `ai:undoToolFileChange`: restores a file to its recorded
  `oldText`, refused when a later edit to the same path would be silently
  discarded (`isLatestEditToPath`, checked both client- and server-side), and
  recorded as a visible `info` event rather than a silent rewrite.

## Acceptance criteria

- A finished session's changeset is fully reviewable and actionable without
  opening a separate diff workspace or terminal.
- Discarding one hunk leaves the rest of that file's edits intact, verified on
  disk.
- Undoing an edit restores exact prior byte content and is refused once a
  later edit to the same path exists.
- The read-only file viewer never renders binary content as text and states
  when it has truncated a large file.

## Task list (retrospective — see commits, not forward-planned tasks)

- `d5ad6c4` — Review and land a session's changes from the inspector.
- `55b77a4` — Read a session's diffs in place, and show how long it took.
- `5222d3e` — Live coverage for a multi-file change and shell use (test).
- `ad30d9a` — A read-only file viewer for a session's changes.
- `e73e301` — A correction loop: discard one hunk, undo one edit. Also added
  `apps/praxis-desktop/renderer/scripts/checkCoreImports.cjs`, enforcing (not
  just documenting) that the renderer never value-imports from `@praxis/core`
  — a real regression this story's own work hit.

## Close when

A session's changeset is reviewable, committable, and correctable — down to
one hunk or one edit — entirely from the Sessions console.

## Description


## Dependencies



## Comments


