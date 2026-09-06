---
**Status:** 📋 Proposed
**Created:** 2026-08-27T21:20:02.000Z
**Type:** Task
**Priority:** Medium
id: TASK-053
title: Renderer stack spike and visual contract gate
status: proposed
story: FX-BE-007
updated: 2026-08-27
dependencies: [FX-BF-005]
validation: ["npm run frontend:build"]
---

# TASK-053: Renderer stack spike and visual contract gate

## Renderer stack spike and visual contract gate

## Goal

Prove the `three` / `@react-three/fiber` / `@react-three/drei` /
`@react-three/postprocessing` stack before committing production code. Build a
throwaway scene: roughly 500 instanced bodies plus 50 full meshes, a camera with
polar and azimuth limits and eased fly-to, raycast selection via
`three-mesh-bvh`, a DOM overlay panel positioned over the live canvas, SDF text
labels, bloom/DOF/vignette, and a `prefers-reduced-motion` path that stops all
motion.

## Done when

- The spike holds 60fps at the target counts on the developer machine and one
  mid-range baseline.
- Camera limits, raycast selection, and the DOM overlay all work over the live
  scene.
- Reduced motion stops camera drift and idle animation.
- The feature plan records either "stack confirmed" or a revised approach.
- No spike code is merged into `AtlasPage`.

## Description


## Dependencies



## Comments


