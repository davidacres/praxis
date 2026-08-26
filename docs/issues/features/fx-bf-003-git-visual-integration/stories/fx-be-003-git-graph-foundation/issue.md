# FX-BE-003: Desktop Git Graph Foundation And Editor Shell

**Status:** Complete
**Feature:** [FX-BF-003](../../feature-issues.md)
**Plan:** [story.md](../../../../../../plans/features/fx-bf-003-git-visual-integration/stories/fx-be-003-git-graph-foundation/story.md)

## Summary

Deliver the first read-only Git graph vertical slice in the Electron desktop app: system Git discovery, commit/branch graph modeling, a typed main/preload/renderer boundary, a polished interactive graph page, and commit inspection.

## Acceptance criteria

1. Repository discovery and missing-Git states are clear and recoverable.
2. Branches, refs, merges, splits, tips, and commit relationships are visible.
3. Selecting a commit shows metadata, parents, children, changed files, and diff actions.
4. Branch focus, merge-only, date filtering, zoom, pan, and refresh work.
5. No Git mutation is enabled before the read-only slice is validated.
