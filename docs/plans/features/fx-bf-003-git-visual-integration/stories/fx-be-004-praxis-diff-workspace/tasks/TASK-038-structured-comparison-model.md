---
id: TASK-038
title: Structured comparison and patch model
status: complete
story: FX-BE-004
updated: 2026-08-27
dependencies: [FX-BE-003]
validation: [npm run test --workspace @ticket-manager/core, npm run test:git --workspace @ticket-manager/electron-app]
---

## Structured Comparison And Patch Model

## Goal

Replace the opaque patch string with typed files, hunks, lines, status, counts, and safe partial-patch operations across core, Electron, preload, and renderer contracts.

## Done when

- Working, staged, commit, ref-range, rename, binary, and untracked comparisons parse deterministically.
- Patch input is path-validated and exercised through real temporary Git repositories.
