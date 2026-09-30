---
**Status:** 🚧 In progress
**Type:** Task
type: Task
id: TASK-390
title: "Add the desktop outbound relay listener"
status: in progress
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

Implemented and tested in Node; not yet exercised in the running Electron app.

- `apps/praxis-desktop/main/src/main/mobileRelayClient.ts`, `mobileRelayStream.ts`, `mobileHostIdentity.ts` (`getMobileRelayIdentity`), `mobileListenerInstance.ts` (`applyRelay`), and `mobileLanServer.ts` (`acceptRelayedStream`, `MobileStream`). `internet` mode holds the relay connection; any other mode closes it.
- Policy: `evaluateMobileAccess` now treats `internet` as relay plus local peers (previously it refused every direct peer); direct peers in `internet` mode must still be on a private address (`isPrivateAddress`). Bug 107-7 (local-only accepts any address) is unchanged.
- Verification: `mobileRelayClient.test.ts` (8 tests) drives a real relay, the desktop client, the production `MobileLanServer` and the phone-side `MobileSecureClient`: read through the relay with no listening socket, wrong pinned key fails, local-only and off refuse a relayed peer, stopping the client and revoking a device close the phone, re-registration after a relay restart, and a recording hop shows only ciphertext. `npm run test:mobile --workspace=@praxis/desktop-main` 80 pass; core suite 1325 pass.
- Remaining: the relay URL comes from `PRAXIS_MOBILE_RELAY_URL` only (no Settings field, so the settings mirror and UI are untouched); no Electron run or e2e; `settings.mobileAccess.remoteSignInRequired` is unused by this path.

## Description


## Comments
