---
**Status:** 🔄 In Progress
**Type:** Task
type: Task
id: TASK-237
title: "Connect native mobile client to desktop host"
status: in-progress
story: FX-BE-077
updated: 2026-09-23
dependencies: [TASK-209, TASK-212]
---

# TASK-237: Connect native mobile client to desktop host

**Priority:** High
**Created:** 2026-09-22

## Goal

Replace the mobile app's simulated connection with a production native transport adapter that discovers or manually resolves a Praxis desktop host, completes the existing authenticated secure-channel handshake, and maintains reconnect state without falling back to demo data.

## Implementation entry points

`apps/praxis-mobile/app/store.tsx`, a new mobile connection/transport service under `apps/praxis-mobile/main`, `@praxis/mobile-protocol`, the desktop `mobileLanServer.ts` host, host identity/trust stores, and desktop Mobile Access settings. Use Expo development/release builds with supported native modules; Expo Go is not a production transport target. Do not weaken the existing Noise authentication or expose desktop credentials to React Native UI components.

## Required implementation

### Shared protocol and security

- Define a versioned pairing response that carries the persistent desktop host ID, host static public key, endpoint hints, granted project scopes/capabilities, pairing expiry, and a transcript-free display name.
- Bind the Noise handshake to the pairing context and both static identities. The desktop must resolve the authenticated mobile public key to one current paired-device record; it must derive `deviceId`, capabilities, and project scope from that record rather than trusting `MobileCommand.caller` or client-supplied grants.
- Re-check revocation, access mode, network policy, project scope, protocol version, frame size, and operation limits before dispatch. Revocation or policy disablement closes existing sockets as well as refusing new ones.
- Specify request/reply IDs, bounded frame sizes, heartbeat/idle timeout, request timeout/cancellation, replay request, event acknowledgement, cursor-expired snapshot fallback, and stable typed transport errors. Do not invent a second wire format for native clients.

### Praxis desktop

- Persist the desktop host identity in protected host storage and keep it stable across restart and IP changes. Make intentional host-key reset visible because every paired phone must distrust the replacement key.
- Add the themed Mobile Access flow that enables/disables the listener, chooses the allowed local interfaces/subnets and port, creates a single-use expiring pairing token/QR, confirms the requesting device and granted scopes, lists paired devices, and revokes them.
- Start, reconfigure, and stop `MobileLanServer` from the saved desktop policy. Surface listening address, port, discovery state, connection count, and actionable bind/discovery failures without exposing private keys.
- Publish authenticated discovery metadata that contains no trust grant; manual host entry must reach the identical identity-verification and pairing path.

### Praxis mobile

- Add native TCP/local-network discovery, camera/QR, secure-key storage, and app-lifecycle adapters supported by both iOS and Android release builds. Generate the mobile static identity on device and keep its private key in Keychain/Keystore-backed storage.
- Implement scan and manual-code pairing, desktop confirmation wait/cancel/expiry, scope review, host-key pinning, remembered hosts, explicit forget/re-pair, manual endpoint editing, and recovery for denied camera/local-network permission.
- Store trust records and event cursors by host identity. Never select cached data by address alone, and purge host-scoped runtime/cache state when a host is forgotten or its key changes.
- Replace `store.connect()`'s timer/demo path with an injected connection service that owns socket lifecycle, handshake, request correlation, event delivery, backoff, foreground reconciliation, and disconnect reasons. UI state consumes this service; screens do not handle sockets or keys directly.

## Acceptance criteria

- Connect opens a real socket to the selected desktop host and completes the existing secure-channel handshake before any application request is accepted.
- A command's effective caller, capabilities, and project scope come only from the desktop's paired-device record for the authenticated mobile key; forged envelope identity or capability fields cannot broaden access.
- A fresh iOS or Android installation can pair by QR or manual code, wait for explicit desktop confirmation, retain trust across both app restarts, and reconnect after the desktop address changes.
- Host and device private keys use OS-protected storage. Logs, protocol errors, screenshots, AsyncStorage, and app state contain no private key, pairing secret, provider credential, transcript body, or raw permission arguments.
- Discovery and manual host entry both resolve into the same authenticated connection path; an unexpected host identity is rejected visibly.
- Connection, reconnect, offline, revoked-device, incompatible-version, and authentication-failure states are distinct and actionable.
- Reconnection preserves the last acknowledged event cursor and does not duplicate accepted events.
- Disabling mobile access, revoking the device, changing its project scope, or resetting the host key takes effect for existing connections within the documented local bound and cannot be bypassed with a cached caller envelope.
- iOS and Android background/foreground transitions never assume an indefinite socket: foreground resumes with authentication and state reconciliation before enabling commands.
- Production builds never silently substitute `DEMO_WORK` or another canned host response after connection failure.

## Dependencies

- TASK-209
- TASK-212

## Verification

- Add protocol/security tests for single-use expiry, desktop confirmation, authenticated-device binding, forged caller/capability/scope, key change, oversized/malformed frames, timeout, replay, and cursor expiry.
- Add deterministic native-adapter and desktop-listener tests for discovery/manual resolution, denied permissions, valid pairing, wrong-host identity, policy reconfiguration, revocation of an open socket, disconnect/reconnect, cursor resume, and snapshot fallback.
- Build iOS and Android development/release variants with the native dependencies; run focused desktop host, access-policy, pairing, protocol, and mobile suites from clean output.
- Record a real iOS and Android device pairing and reconnection to a running Praxis desktop instance with internet, GenericSystem, Roleover, and Azure unavailable.
- Required repository checks: `npm run check-types`, `npm run test:mobile-protocol`, `npm run test:mobile`, `npm run test:desktop:mobile`, and `npm run build`. Native build commands and device/OS versions must be recorded in completion evidence.

## Done when

- The React Native application establishes and restores a real authenticated desktop connection through one production transport path.
- Desktop settings can create, inspect, restrict, and revoke that pairing, and the running listener applies those changes without restart.
- Authenticated device identity—not client assertions—authorises every read, command, replay, and pushed event.
- The demo connection remains available only behind an explicit development/test fixture boundary.

## Notes

This task owns the concrete pairing and platform-adapter work left out of TASK-209 through TASK-211. It does not own session rendering or execution commands beyond the minimum authenticated read/replay needed to prove connectivity. Completion evidence must name the shipping iOS/Android adapters and desktop settings/listener paths; helper predicates or loopback-only fixtures cannot close it.

## Progress (2026-09-23)

Source work for this task's typed disconnect reasons, token-gated pairing wait/cancel/expiry, forget/re-pair, backoff and foreground reconciliation is implemented and covered by protocol, desktop and
mobile tests plus `mobileEndToEnd.test.ts` (real listener + host services + the
phone's client). The iOS Release build is installed on a physical iPhone and
launches (`Running "main"`). Still open: the recorded physical-device journey
against a desktop running revision 2, and Android. Status stays In Progress.

## Description


## Comments


