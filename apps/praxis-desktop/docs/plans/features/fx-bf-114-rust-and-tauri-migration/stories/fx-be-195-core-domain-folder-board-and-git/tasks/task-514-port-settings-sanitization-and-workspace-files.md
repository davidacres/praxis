---
**Created:** 2026-11-07T21:21:09.521Z
id: TASK-514
type: Task
status: To Do
---

# Port AppSettings sanitization and .workspace.praxis.json I/O

**Status:** To Do
**Type:** Task
**Priority:** Critical

## Description

Port `sanitizeAppSettings`, `mergeAppSettings`, and strict CSS literal validation (hex colors and blend modes) to `crates/praxis-core::config`. Port `toWorkspaceFile`, `readWorkspaceFile`, and `workspacePaths` to `crates/praxis-core::workspaces`, preserving secret-key stripping (`/token|secret|password|apikey|api_key|\bpat\b/i`), relative POSIX path normalization for folders inside the workspace file's directory tree, and removal of `folderInspection` on write.

## Acceptance Criteria

- Golden JSON serialization tests match `packages/core/src/config/appSettings.test.ts` and `packages/core/src/workspaces/workspacePaths.test.ts`.
- `workspaceFile.spec.ts` passes end-to-end.

## Dependencies

- `FX-BE-194`

## Comments


