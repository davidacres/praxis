---
**Status:** 📋 Proposed
**Created:** 2026-08-31T12:27:32.003Z
**Type:** Task
**Priority:** Medium
id: TASK-052
title: Verify navigation semantics, accessibility, responsive layout, and migration snapshots
status: complete
story: FX-BE-006
updated: 2026-08-27
dependencies: [TASK-049, TASK-050, TASK-051]
validation: ["npm run frontend:build", "npm run electron:check-types", "npm run electron:copy-renderer", "npm run test:e2e --workspace @praxis/desktop-main -- e2e/projects.spec.ts"]
---

## Verify navigation semantics, accessibility, responsive layout, and migration snapshots

## Goal

Prove the new tree is understandable and stable in the packaged renderer.

## Done when

- E2E covers project selection, expansion, board selection, Git selection, folderless setup, non-repository onboarding, and return navigation.
- Keyboard focus, aria labels, disabled states, and narrow sidebar behavior are verified.
- Intentional visual snapshots are updated and unrelated snapshots are preserved.
- Build, typecheck, copied renderer, focused tests, and `git diff --check` pass.

## Description


## Dependencies



## Comments


