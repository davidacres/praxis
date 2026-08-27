---
id: TASK-056
title: Atlas scene, LOD tiers, and semantic-zoom camera
status: proposed
story: FX-BE-007
updated: 2026-08-27
dependencies: [TASK-053, TASK-055]
validation: ["npm run frontend:build", "npm run electron:check-types"]
---

## Atlas scene, LOD tiers, and semantic-zoom camera

## Goal

Build `AtlasPage` in `packages/frontend`: an r3f canvas with a starfield, four
level-of-detail tiers (universe, project, board, task) driven by `AtlasLayout`,
instanced distant bodies with full meshes near the camera, and a semantic-zoom
camera rig — eased fly-to between focus targets, a breadcrumb trail, a back
action, a snap-to-overview key, and an exit key.

## Done when

- A person can fly through all four tiers on the fixture.
- The camera respects its polar/azimuth and distance limits.
- LOD swaps are not visually jarring.
- Empty, loading, and error states render.
