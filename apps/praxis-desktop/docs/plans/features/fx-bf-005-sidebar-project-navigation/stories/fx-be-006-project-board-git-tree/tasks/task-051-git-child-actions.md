---
**Status:** ✅ Complete
**Created:** 2026-08-27T21:20:02.000Z
**Type:** Task
**Priority:** Medium
id: TASK-051
title: Connect Git child actions to Graph, Changes, and Conflict contexts
status: Done
story: FX-BE-006
updated: 2026-10-10
dependencies: [TASK-049]
validation: ["npm run electron:check-types", "npm run test:e2e --workspace @praxis/desktop-main -- e2e/gitGraph.spec.ts"]
---

# TASK-051: Connect Git child actions to Graph, Changes, and Conflict contexts

## Connect Git child actions to Graph, Changes, and Conflict contexts

## Goal

Route project Git children into the existing validated repository context without reintroducing global process-directory behavior.

## Done when

- Graph is the default Git child and opens with the active project's workspace.
- Changes opens the clean diff workspace and Conflicts appears only when status reports conflicts.
- All child routes retain project identity and return safely to the project tree.

## Description


## Dependencies



## Comments

**2026-10-10:** Closed during backlog review: the work is implemented in the shipped code (renderer, main and core) and the parent feature's 'As built' notes; the ticket's status had not been rolled up.
