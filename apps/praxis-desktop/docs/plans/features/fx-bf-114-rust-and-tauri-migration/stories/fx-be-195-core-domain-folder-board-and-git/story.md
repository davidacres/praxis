---
**Created:** 2026-11-07T21:21:07.127Z
id: FX-BE-195
type: Story
status: In Progress
---

# Port Core Settings, Workspaces, Folder Backend, and Git to Rust

**Status:** In Progress
**Type:** Story
**Priority:** Critical

## Description

Port the deterministic local domain foundations from `@praxis/core` and `@praxis/desktop-main` into `crates/praxis-core` and `crates/praxis-trackers`: `AppSettings` sanitization/migration, `.workspace.praxis.json` portable file I/O, `ProjectWorkflowStage` status resolution (`resolveStatus`), `FolderService` (`board.praxis.json`, `markdownPlanParser`, `ensureFrontMatter`, `writeProjectSnapshot` for `project.praxis.md`), `git` CLI parsing/worktrees, path sandboxing, unified diff application, and marketplace archive verification.

### Execution Order & Parallelism (Wave 2 — P0 Critical Path + 3-Way Fan-Out)

- **Sequential Unblocker**: `TASK-514` (`AppSettings` sanitization and `.workspace.praxis.json` I/O) runs first to establish `crates/praxis-core::config` and `workspaces`.
- **3-Way Parallel Fan-Out**: Once `TASK-514` completes, `TASK-515` (`FolderService` & `resolveStatus`), `TASK-516` (`git` CLI & worktrees), and `TASK-517` (`pathSandbox`, `networkAddress`, `unifiedDiff`, `marketplace`) live in separate submodules with zero file overlap and can be executed simultaneously across 3 parallel worktrees.

## Tasks

- `TASK-514` (`Critical`, Sequential Step 1) — Port AppSettings sanitization and .workspace.praxis.json I/O
- `TASK-515` (`Critical`, Parallel Track 2A) — Port resolveStatus, markdownPlanParser, and FolderService
- `TASK-516` (`High`, Parallel Track 2B) — Port git CLI parser, graph builder, and worktree manager
- `TASK-517` (`Medium`, Parallel Track 2C) — Port pathSandbox, unifiedDiff, and marketplace archive verifier

## Acceptance Criteria

- `folder.spec.ts`, `folderMulti.spec.ts`, `editIssue.spec.ts`, and `newIssue.spec.ts` hold at 13 passed against the Rust implementation.
- `projectSnapshot.test.ts` invariants hold: marker-less `project.praxis.md` files are never overwritten, and marked files update only between `<!-- praxis:begin -->` and `<!-- praxis:end -->`.
- `npm run test:desktop:git`, `workspaceFile.spec.ts`, and `journey.spec.ts` pass without touching working-tree `.praxis.` files.

## Dependencies

- `FX-BE-194`

## Comments


