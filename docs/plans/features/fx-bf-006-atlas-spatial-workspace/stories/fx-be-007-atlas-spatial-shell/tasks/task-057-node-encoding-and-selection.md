---
**Status:** 📋 Proposed
**Created:** 2026-08-27T21:20:02.000Z
**Type:** Task
**Priority:** Medium
id: TASK-057
title: Node visual encoding and raycast selection into detail surfaces
status: proposed
story: FX-BE-007
updated: 2026-08-27
dependencies: [TASK-056]
validation: ["npm run frontend:build", "npm run electron:check-types"]
---

# TASK-057: Node visual encoding and raycast selection into detail surfaces

## Node visual encoding and raycast selection into detail surfaces

## Goal

Encode node data visually — shape = issue type, colour = status
(colour-blind-safe palette), idle spin rate = recency of activity, surface
material = state — plus a visible tether from a blocked task to its blocker and a
halo on a ready-to-start task. Wire raycast selection to open the existing
`IssueDetail` or session view as a DOM overlay.

## Done when

- Issue type, status, and recency are each readable without relying on colour
  alone.
- A blocked task shows its tether to the blocker; a ready-to-start task shows its
  halo.
- Selecting a body opens the correct existing detail surface while the scene
  keeps rendering behind it.

## Description


## Dependencies



## Comments


