---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-389
title: "Extend QR pairing with a relay route and host channel"
status: backlog
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

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Description


## Comments
