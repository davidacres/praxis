---
id: TASK-039
title: Clean responsive diff workspace
status: complete
story: FX-BE-004
updated: 2026-08-27
dependencies: [TASK-038]
validation: [npm run build --workspace @ticket-manager/frontend, packages/electron-app/output/playwright/praxis-diff-workspace.png]
---

## Clean Responsive Diff Workspace

## Goal

Deliver a full-width Praxis comparison surface with changed-file navigation and Inline, Split, and Hunk reading modes.

## Done when

- Line numbers, syntax color, word emphasis, wrap, whitespace, change navigation, binary states, loading, empty, and failure states are present.
- Wide and narrow screenshots prove the hierarchy remains usable.
