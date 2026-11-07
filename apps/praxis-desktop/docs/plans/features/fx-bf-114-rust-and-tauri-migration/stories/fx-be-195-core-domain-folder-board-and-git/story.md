---
**Created:** 2026-11-07T21:21:07.127Z
id: FX-BE-195
type: Story
status: To Do
---

# Port Core Settings, Workspaces, Folder Backend, and Git to Rust

**Status:** To Do
**Type:** Story
**Priority:** High

## Description

Port the deterministic local domain foundations from `@praxis/core` and `@praxis/desktop-main` into `crates/praxis-core` and `crates/praxis-trackers`: `AppSettings` sanitization/migration, `.workspace.praxis.json` portable file I/O, `ProjectWorkflowStage` status resolution (`resolveStatus`), `FolderService` (`board.praxis.json`, `markdownPlanParser`, `ensureFrontMatter`, `writeProjectSnapshot` for `project.praxis.md`), `git` CLI parsing/worktrees, path sandboxing, unified diff application, and marketplace archive verification.

## Tasks

- `TASK-514` — Port AppSettings sanitization and .workspace.praxis.json I/O
- `TASK-515` — Port resolveStatus, markdownPlanParser, and FolderService
- `TASK-516` — Port git CLI parser, graph builder, and worktree manager
- `TASK-517` — Port pathSandbox, unifiedDiff, and marketplace archive verifier

## Acceptance Criteria

- `folder.spec.ts`, `folderMulti.spec.ts`, `editIssue.spec.ts`, and `newIssue.spec.ts` hold at 13 passed against the Rust implementation.
- `projectSnapshot.test.ts` invariants hold: marker-less `project.praxis.md` files are never overwritten, and marked files update only between `<!-- praxis:begin -->` and `<!-- praxis:end -->`.
- `npm run test:desktop:git`, `workspaceFile.spec.ts`, and `journey.spec.ts` pass without touching working-tree `.praxis.` files.

## Dependencies

- `FX-BE-194`

## Comments


