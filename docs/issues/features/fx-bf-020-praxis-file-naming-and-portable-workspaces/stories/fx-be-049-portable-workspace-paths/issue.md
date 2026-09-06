# FX-BE-049 — Workspace files store in-tree paths relative to themselves

**Type:** Story  **Status:** Complete  **Priority:** P2  **Depends on:** —

## Business or operational impact
A workspace file is designed to be committed — secrets are stripped precisely so it can be — but it stored absolute paths, so it resolved on exactly one machine. The stated purpose did not survive the trip.

## Scope
- In-tree paths stored relative to the file, POSIX separators; out-of-tree paths stay absolute because there is nothing to make them relative to.
- `folderInspection` is dropped on write: a cache of *local* filesystem facts (languages, manifests, git state) must not be handed to someone else as if it were theirs. It re-derives.
- Applies to `ProjectRecord.workspaceFolder` and folder-connection `settings.roots`.

## Acceptance criteria
- The same file opened from a different absolute root resolves every folder into that root.
- An out-of-tree folder round-trips unchanged.
- This repository's own workspace file contains no machine path.

## Close when
A committed workspace file can be cloned and opened by someone else without editing.
