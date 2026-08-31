---
**Status:** 📋 Proposed
**Created:** 2026-08-31T12:27:32.004Z
**Type:** Task
**Priority:** Medium
id: TASK-055
title: Deterministic orbital layout solver in core
status: proposed
story: FX-BE-007
updated: 2026-08-27
dependencies: [TASK-054]
validation: ["npm run core:check-types", "npm run test --workspace @praxis/core"]
---

## Deterministic orbital layout solver in core

## Goal

Add `AtlasLayoutSolver` in `packages/core`: given an `AtlasSnapshot`, produce an
immutable `AtlasLayout` of 3D positions per node for each tier. Orbit radius is
derived from time horizon and priority, angular slots are assigned to avoid
overlap, and children are grouped under their parent. Placement is deterministic
and stable when unrelated nodes are added or removed.

## Done when

- Unit tests prove determinism for a fixed snapshot, non-overlap within a tier,
  and that adding or removing one project does not move unrelated bodies.
- Output is immutable and serializable across the IPC boundary.
- No randomness or wall-clock input in the solver.

## Description


## Dependencies



## Comments


