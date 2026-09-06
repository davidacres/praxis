---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-108
title: Persist project workflows to .praxis/workflows with path safety and reload
status: complete
story: FX-BE-023
updated: 2026-09-02
dependencies: [FX-BE-021]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# TASK-108: Persist project workflows to .praxis/workflows with path safety and reload
## Persist project workflows to .praxis/workflows with path safety and reload
## Goal
Make a folder-backed project's workflows real files under
`<workspaceFolder>/.praxis/workflows/<id>.json` so they are version-controlled
and shareable, instead of only living in the app-local draft store.
## Done when
- `workflows:save` writes a pretty-printed JSON file when the project has a
  `workspaceFolder`; the filename is derived from the workflow id and rejected
  if it is not a safe single path segment (no traversal, no separators).
- The draft store remains the path for folderless projects and for an
  uncommitted edit; a committed file takes precedence on the next read.
- Removing a workflow deletes its file; editing a file on disk is picked up on
  reload without a restart.
- Core tests cover the id→filename safety check; a desktop test writes, reloads,
  and edits a committed workflow.
## Notes
`resolveManifestPath` in `ai/agentRuntime/manifest.ts` already models the
path-escape guard. Do not require git — writing the file is a filesystem
operation; staging it is the user's choice.

## Description


## Dependencies



## Comments


