---
**Status:** 🚧 In progress
**Type:** Task
type: Task
id: TASK-389
title: "Extend QR pairing with a relay route and host channel"
status: in progress
story: FX-BE-079
updated: 2026-09-29
dependencies: [TASK-216, TASK-207]
---

# TASK-389: Extend QR pairing with a relay route and host channel

**Priority:** Low
**Created:** 2026-09-29

## Goal

Add the relay URL, an opaque host channel ID and the host's relay-registration public key to the QR payload beside the existing LAN hints. The token stays single-use and expiring and never becomes a reusable secret. Pairing registers the device key with the host. A remote route is only offered while the access mode allows it, and remote-only pairing needs a fresh QR.

## Implementation entry points

`packages/core/src/host/mobilePairingHandshake.ts`, the desktop pairing UI and the phone invitation parser (`lib/core` invitation logic).

## Acceptance criteria

- Expired, replayed and substituted-host QR payloads still fail; a QR is never accepted with an unknown relay route shape.
- Pairing over the relay yields the same trusted device record as LAN pairing and the same revocation path.

## Dependencies

- TASK-216
- TASK-207

## Verification

Use deterministic host/protocol fixtures and disposable project directories. Run focused contract and integration checks (`flutter analyze`, `flutter test`, the core host tests). For UI changes, build the affected app and inspect fresh captures. Prove regression guards fail on the broken behaviour. Real relay hosting is an explicit opt-in; record real-service evidence separately from mocks. Never run a Praxis write path against this repository's plans.

## Completion evidence

Route carried end to end in code; the Dart half is unverified.

- Core: `MobilePairingInvitation.relay` and `compactMobilePairingPayload` append `relayUrl|channel` after the existing six parts, so an older phone still parses the QR (`mobilePairingHandshake.ts`, test added). Desktop: registry and pairing instance pass the live relay route (only while registered) into the invitation; the renderer's duplicate of the payload function is updated (`SettingsPage.tsx`).
- Phone (Dart): `lib/core/invitation.dart` parses the route from the compact and JSON forms and drops a half or malformed route; `HostConfiguration` stores it; test cases added to `test/core/logic_test.dart`.
- Not verified: no Dart/Flutter SDK is available in this environment (the network blocks its download), so `flutter analyze` and `flutter test` have not been run. The Settings page QR was not viewed.
- Remaining: expiry, single-use token and replay behaviour are the existing TASK-207 rules and are unchanged; a remote-only QR (no LAN address) is not supported.

## Description


## Comments
