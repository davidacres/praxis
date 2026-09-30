---
**Status:** 🚧 In progress
**Type:** Story
type: Story
id: FX-BE-079
title: "Account-free relay and remote pairing"
status: in progress
feature: FX-BF-030
updated: 2026-09-29
dependencies: [FX-BE-076, FX-BE-077]
---

# FX-BE-079: Account-free relay and remote pairing

**Priority:** Low
**Created:** 2026-09-09

## Outcome

A QR-paired phone reaches its desktop over a self-hostable WebSocket relay, from a separate network, with no account.

## Scope and implementation entry points

A small relay service (hosting chosen by TASK-216), the QR/pairing payload in `packages/core/src/host/mobilePairingHandshake.ts`, a desktop outbound relay listener beside `mobileHostListener.ts`, and a Flutter WebSocket transport under `lib/protocol/client.dart` (today `MobileSecureClient` is tied to a `dart:io` `Socket`).

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-216](tasks/task-216-spike-relay-hosting-and-flutter-websocket-transport.md) | Spike relay hosting and Flutter WebSocket transport |
| 2 | [TASK-217](tasks/task-217-implement-account-free-byte-relay-with-per-host-quotas.md) | Implement the account-free byte relay with per-host quotas |
| 3 | [TASK-389](tasks/task-389-extend-qr-pairing-with-relay-route-and-host-channel.md) | Extend QR pairing with a relay route and host channel |
| 4 | [TASK-390](tasks/task-390-add-desktop-outbound-relay-listener.md) | Add the desktop outbound relay listener |
| 5 | [TASK-391](tasks/task-391-add-flutter-relay-transport-and-route-selection.md) | Add the Flutter relay transport and route selection |
| 6 | [TASK-218](tasks/task-218-secure-end-to-end-relay-traffic-and-route-changes.md) | Prove secure end-to-end relay traffic and route changes |
| 7 | [TASK-392](tasks/task-392-qualify-account-free-relay-for-release.md) | Qualify the account-free relay for release |

## Acceptance criteria

- One desktop and one physical phone exchange encrypted fixture commands from separate networks with no inbound router ports or VPN.
- A guessed channel ID, forged registration, revoked device or unpaired key gets no usable route; per-host quotas and handshake timeouts hold under abuse.
- The relay operator cannot read fixture payloads; tampering, replay and identity substitution fail. Mobile-data/LAN switching does not duplicate work. Selecting local-only or revoking a device closes active remote channels.

## Exclusions

No accounts, GenericSystem, Roleover or Azure. No board, workflow or agent administration on mobile. No VPN dependency. No push notifications (FX-BE-086).

## Dependencies

- FX-BE-076
- FX-BE-077

## Verification

Use deterministic host/protocol fixtures and disposable project directories. Run focused contract and integration checks (`flutter analyze`, `flutter test`, the core host tests). For UI changes, build the affected app and inspect fresh captures. Prove regression guards fail on the broken behaviour. Real relay hosting is an explicit opt-in; record real-service evidence separately from mocks. Never run a Praxis write path against this repository's plans.

## Completion evidence

Partly implemented; see the task evidence. The relay service, desktop client and QR route are built and tested in Node. The Flutter transport is written but unverified, the relay hosting decision (TASK-216) and the physical-phone proof (TASK-218) are not done.

## Description


## Comments
