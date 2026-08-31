# TASK-036: Git Mutations And Refresh

**Created:** 2026-08-31T12:27:31.999Z
**Type:** Task
**Priority:** Medium
**Status:** Complete
**Depends on:** TASK-035
**Parallel with:** None

## Work

Add status, stage/unstage, commit, branch create/delete/checkout, pull, and push behind explicit IPC handlers and confirmation/progress UX. Refresh graph state after successful mutations and preserve the last safe snapshot on failure.

## Done when

Mutations use the same argument-array runner, show progress and actionable errors, never discard local changes silently, and expose stage/unstage, commit, branch create/delete/checkout, pull, and push through the desktop Git Graph action surface. The Electron visual test exercises the working-tree panel and action controls without mutating the repository.

## Description


## Dependencies



## Comments


