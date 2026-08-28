---
id: TASK-051
title: Connect Git child actions to Graph, Changes, and Conflict contexts
status: complete
story: FX-BE-006
updated: 2026-08-27
dependencies: [TASK-049]
validation: ["npm run electron:check-types", "npm run test:e2e --workspace @praxis/desktop-main -- e2e/gitGraph.spec.ts"]
---

## Connect Git child actions to Graph, Changes, and Conflict contexts

## Goal

Route project Git children into the existing validated repository context without reintroducing global process-directory behavior.

## Done when

- Graph is the default Git child and opens with the active project's workspace.
- Changes opens the clean diff workspace and Conflicts appears only when status reports conflicts.
- All child routes retain project identity and return safely to the project tree.
