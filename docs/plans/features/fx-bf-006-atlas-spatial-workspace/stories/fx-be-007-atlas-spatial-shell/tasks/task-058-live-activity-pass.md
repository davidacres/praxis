---
**Status:** 📋 Proposed
**Created:** 2026-08-31T12:27:32.008Z
**Type:** Task
**Priority:** Medium
id: TASK-058
title: Live activity pass and the awaiting-approval signal
status: proposed
story: FX-BE-007
updated: 2026-08-27
dependencies: [TASK-056]
validation: ["npm run frontend:build", "npm run electron:check-types"]
---

## Live activity pass and the awaiting-approval signal

## Goal

Add the live activity pass, subscription-driven and decoupled from layout:
running sessions show motion and heat, a session awaiting user approval is a
distinct bright signal visible from the universe tier, and a completing task
snaps its dependents' tethers.

## Done when

- Toggling a fixture session between running, awaiting-approval, and done updates
  the scene within one frame budget without recomputing layout.
- The awaiting-approval signal is visible at the universe tier.
- The activity pass reads only from the live subscription and never writes
  `AtlasLayout`.

## Description


## Dependencies



## Comments


