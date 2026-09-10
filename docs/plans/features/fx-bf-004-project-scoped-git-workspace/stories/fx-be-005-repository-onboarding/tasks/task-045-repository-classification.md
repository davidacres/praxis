---
**Status:** 📋 Proposed
**Created:** 2026-08-27T21:20:02.000Z
**Type:** Task
**Priority:** Medium
id: TASK-045
title: Implement Electron repository classification and safe initialization/open actions
status: Done
story: FX-BE-005
updated: 2026-08-27
dependencies: [TASK-044]
validation: ["npm run test --workspace @praxis/core", "npm run test:git --workspace @praxis/desktop-main"]
---

# TASK-045: Implement Electron repository classification and safe initialization/open actions

## Implement Electron repository classification and safe initialization/open actions

## Goal

Add main-process repository preflight using argument-array Git execution, filesystem checks, native folder selection, and an explicit initialize operation.

## Done when

- Preflight resolves the Git repository root for normal repositories and worktrees.
- Non-repository and inaccessible paths return typed results without throwing raw Git stderr.
- Initialization requires a dedicated request and is bounded to the selected project folder.
- Tests cover temporary repositories, missing folders, non-repositories, worktrees, and initialization.

## Notes

Never initialize, checkout, or otherwise mutate as a side effect of opening Git Graph.

## Description


## Dependencies



## Comments


