---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-390
title: "Add the desktop outbound relay listener"
status: backlog
story: FX-BE-079
updated: 2026-09-29
dependencies: [TASK-217, TASK-389]
---

# TASK-390: Add the desktop outbound relay listener

**Priority:** Low
**Created:** 2026-09-29

## Goal

Hold an outbound relay connection and feed each relayed stream into the existing host listener and Noise IK responder, so authentication, scopes and the command journal are shared with LAN. Reconnect with backoff. The access policy is enforced on new and established relay connections.

## Implementation entry points

`packages/core/src/host/mobileHostListener.ts`, `mobileAccessPolicy.ts`, `mobileConnectionLifecycle.ts`.

## Acceptance criteria

- Local-only or Off closes the relay connection and live remote channels, and stops registration.
- Revoking a device denies its next relay connection and drops a live one.
- LAN behaviour is unchanged (existing host tests hold).

## Dependencies

- TASK-217
- TASK-389

## Verification

Use deterministic host/protocol fixtures and disposable project directories. Run focused contract and integration checks (`flutter analyze`, `flutter test`, the core host tests). For UI changes, build the affected app and inspect fresh captures. Prove regression guards fail on the broken behaviour. Real relay hosting is an explicit opt-in; record real-service evidence separately from mocks. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Description


## Comments
