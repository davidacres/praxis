---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-237
title: "Connect native mobile client to desktop host"
status: planned
story: FX-BE-077
updated: 2026-09-22
dependencies: [TASK-212]
---

# TASK-237: Connect native mobile client to desktop host

**Priority:** High
**Created:** 2026-09-22

## Goal

Replace the mobile app's simulated connection with a production native transport adapter that discovers or manually resolves a Praxis desktop host, completes the existing authenticated secure-channel handshake, and maintains reconnect state without falling back to demo data.

## Implementation entry points

`apps/praxis-mobile/app/store.tsx`, the mobile native transport boundary, `@praxis/mobile-protocol`, and the desktop `mobileLanServer.ts` host. Use a development-client-compatible native socket implementation; do not weaken the existing Noise authentication or expose desktop credentials to the React Native renderer.

## Acceptance criteria

- Connect opens a real socket to the selected desktop host and completes the existing secure-channel handshake before any application request is accepted.
- Discovery and manual host entry both resolve into the same authenticated connection path; an unexpected host identity is rejected visibly.
- Connection, reconnect, offline, revoked-device, incompatible-version, and authentication-failure states are distinct and actionable.
- Reconnection preserves the last acknowledged event cursor and does not duplicate accepted events.
- Production builds never silently substitute `DEMO_WORK` or another canned host response after connection failure.

## Dependencies

- TASK-212

## Verification

- Add deterministic adapter tests against the desktop LAN host fixture, including valid pairing, wrong-host identity, disconnect/reconnect, cursor resume, and revoked-device cases.
- Build the mobile app with its native dependency and run the focused desktop host/protocol tests.
- Record a simulator or physical-device connection to a running Praxis desktop instance with GenericSystem, Roleover and Azure unavailable.

## Done when

- The React Native application establishes and restores a real authenticated desktop connection through one production transport path.
- The demo connection remains available only behind an explicit development/test fixture boundary.

## Notes

This task owns the concrete platform adapter left out of TASK-210 and TASK-211. It does not own session rendering or execution commands beyond the minimum handshake and transport requests needed to prove connectivity.
