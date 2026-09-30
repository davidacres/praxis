---
**Status:** 🚧 In progress
**Type:** Task
type: Task
id: TASK-391
title: "Add the Flutter relay transport and route selection"
status: in progress
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

Written but not compiled or run: no Dart/Flutter SDK is available in this environment.

- `lib/protocol/client.dart`: `MobileSecureClient` takes an optional `relayUrl`/`relayChannel` and, when both are set, connects with `dart:io` `WebSocket` to `/v1/connect?channel=` and runs the same Noise IK records over it (a private `_Link` replaces the direct `Socket`). Relay close codes 4404/4408/4429/4430/4503 become an `unreachable` error.
- `lib/app/connection.dart`: `NativeMobileConnection.connect` tries the LAN first (4 s) and falls back to the relay only on `unreachable` or `timed-out`; a revoked device, wrong key or refused access is final. The LAN attempt's failure is not reported as a close event.
- Remaining: run `flutter analyze` and `flutter test`; test on a physical phone over mobile data; the LAN attempt costs up to 4 s on every off-network reconnect (no remembered route); no test for the fallback logic.

## Description


## Comments
