---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-218
title: "Prove secure end-to-end relay traffic and route changes"
status: backlog
story: FX-BE-079
updated: 2026-09-29
dependencies: [TASK-390, TASK-391]
---

# TASK-218: Prove secure end-to-end relay traffic and route changes

**Priority:** Low
**Created:** 2026-09-09

## Goal

Show that the existing Noise IK channel, run above the relay, keeps payloads unreadable to the relay operator and that the command journal and cursors make route changes safe. TLS to the relay alone is not the protection.

## Implementation entry points

The relay, the desktop relay listener, the Flutter relay transport and the protocol tests.

## Acceptance criteria

- A relay-side capture of fixture traffic contains no plaintext; tampered, replayed and identity-substituted records fail.
- Mobile-data/LAN switching does not duplicate work. Local-only or device revocation closes active remote channels.

## Dependencies

- TASK-390
- TASK-391

## Verification

Use deterministic host/protocol fixtures and disposable project directories. Run focused contract and integration checks (`flutter analyze`, `flutter test`, the core host tests). For UI changes, build the affected app and inspect fresh captures. Prove regression guards fail on the broken behaviour. Real relay hosting is an explicit opt-in; record real-service evidence separately from mocks. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Deferred internet milestone evidence

After local release, prove the full start/continue/approve/retry/cancel journey through the relay on a physical phone, including LAN handoff, expired pairing tokens and device revocation.

## Description


## Comments
