---
**Status:** 📋 Proposed
**Created:** 2026-08-31T12:27:32.001Z
**Type:** Task
**Priority:** Medium
id: TASK-044
title: Define project Git context and typed repository preflight contract
status: complete
story: FX-BE-005
updated: 2026-08-27
dependencies: [FX-BF-003]
validation: ["npm run electron:check-types"]
---

# TASK-044: Define project Git context and typed repository preflight contract

## Define project Git context and typed repository preflight contract

## Goal

Define the shared/preload contracts for project Git context, repository status, and safe next actions without exposing raw subprocess errors to the renderer.

## Done when

- Contracts distinguish no folder, missing folder, inaccessible folder, non-repository, valid repository, worktree, and bare repository as required by UX.
- The contract carries repository root and a safe display message where available.
- Initialization/open/choose-folder requests have explicit intent and cancellation semantics.
- Core and Electron type checks pass.

## Notes

Do not make renderer code infer repository state from error strings.

## Description


## Dependencies



## Comments


