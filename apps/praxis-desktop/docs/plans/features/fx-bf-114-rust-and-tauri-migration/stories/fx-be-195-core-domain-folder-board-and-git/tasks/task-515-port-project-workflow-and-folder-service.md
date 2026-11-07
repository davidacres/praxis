---
**Created:** 2026-11-07T21:21:09.522Z
id: TASK-515
type: Task
status: To Do
---

# Port resolveStatus, markdownPlanParser, and FolderService

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Port `resolveStatus(raw, workflow)` and `DEFAULT_WORKFLOW` (`projects/projectWorkflow.ts`) to `crates/praxis-core::projects`, preserving `ProjectWorkflowStage` `{ id, name, category }` across all serialization paths. Port `board.praxis.json` loading (ensuring `loadFromDisk` reads `board.praxis.json` *before* parsing markdown plans), `markdownPlanParser`, `markdownStatusWriter` (`ensureFrontMatter`), `writeProjectSnapshot` (`project.praxis.md` with `praxis:begin`/`praxis:end` marker protection), and `FolderService` backed by `notify` file watching.

## Acceptance Criteria

- `folder.spec.ts`, `folderMulti.spec.ts`, `editIssue.spec.ts`, `newIssue.spec.ts`, and `journey.spec.ts` pass.
- Running the parser over `apps/praxis-desktop/docs/plans` produces identical feature, story, and child item counts, keys, statuses, and dependency graphs as the TypeScript parser.

## Dependencies

- `TASK-514`

## Comments


