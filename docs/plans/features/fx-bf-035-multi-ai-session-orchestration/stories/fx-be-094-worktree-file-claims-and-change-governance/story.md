---
**Status:** 📋 Proposed
**Created:** 2026-09-10T10:48:08.260Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-094
title: "Worktree, file claims and change governance"
status: To Do
feature: FX-BF-035
updated: 2026-09-10
dependencies: [FX-BE-092, FX-BF-003]
---

# FX-BE-094: Worktree, file claims and change governance

## Outcome

Provider sessions are isolated, scoped and independently attributable.

## Tasks

- **TASK-262 Implement per-session branch and worktree creation, cleanup and dirty-worktree protection.**
- **TASK-263 Add path claims, overlap detection, expiry and release handling.**
- **TASK-264 Capture initial and final Git state, changed paths, diff statistics and out-of-scope changes.**
- **TASK-265 Implement merge-candidate preparation, conflict detection and safe recovery.**

## Acceptance

Two sessions cannot acquire overlapping write claims. An undeclared path change is blocked or escalated according to policy. A dirty worktree is never silently deleted. Every change set identifies session, task, source commit and final commit.

## Evidence

Contract tests, fixture repositories, captured provider output, failure and recovery tests, and visual or accessibility evidence where the story affects the desktop surface.

## Description


## Dependencies



## Comments


