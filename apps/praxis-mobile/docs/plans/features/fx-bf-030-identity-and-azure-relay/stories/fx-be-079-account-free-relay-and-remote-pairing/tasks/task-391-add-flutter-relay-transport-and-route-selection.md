---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-391
title: "Add the Flutter relay transport and route selection"
status: backlog
story: FX-BE-079
updated: 2026-09-29
dependencies: [TASK-217, TASK-389]
---

# TASK-391: Add the Flutter relay transport and route selection

**Priority:** Low
**Created:** 2026-09-29

## Goal

Abstract the transport under MobileSecureClient (currently a dart:io Socket) so a WebSocket to the relay can carry the same length-prefixed Noise IK records. Prefer the LAN route and fall back to the relay; switch on network change.

## Implementation entry points

`apps/praxis-mobile/lib/protocol/client.dart`, `secure_channel.dart`, `lib/app` connection lifecycle.

## Acceptance criteria

- The same client tests pass over both transports; `flutter analyze` is clean.
- Switching between LAN and mobile data reconnects without duplicating commands.

## Dependencies

- TASK-217
- TASK-389

## Verification

Use deterministic host/protocol fixtures and disposable project directories. Run focused contract and integration checks (`flutter analyze`, `flutter test`, the core host tests). For UI changes, build the affected app and inspect fresh captures. Prove regression guards fail on the broken behaviour. Real relay hosting is an explicit opt-in; record real-service evidence separately from mocks. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Description


## Comments
