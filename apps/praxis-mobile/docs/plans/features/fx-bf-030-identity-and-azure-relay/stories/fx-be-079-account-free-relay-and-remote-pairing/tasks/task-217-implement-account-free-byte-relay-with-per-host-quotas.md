---
**Status:** ✅ Complete
**Type:** Task
type: Task
id: TASK-217
title: "Implement the account-free byte relay with per-host quotas"
status: complete
story: FX-BE-079
updated: 2026-09-29
dependencies: [TASK-216]
---

# TASK-217: Implement the account-free byte relay with per-host quotas

**Priority:** Low
**Created:** 2026-09-09

## Goal

A relay that pairs two outbound WebSockets by opaque channel ID and forwards bytes it cannot read. Registration requires a signed challenge from a host key registered at pairing. Enforce per-host-key connection caps, handshake timeouts, message-size and rate limits, and idle expiry. No accounts, no payload logging, TLS only. Deployable as a single container or worker.

## Implementation entry points

The relay service chosen by TASK-216.

## Acceptance criteria

- A guessed channel ID, forged registration or unsigned connection gets no forwarding.
- Caps, timeouts, size and rate limits reject abusive fixtures; secrets and payloads are absent from logs and committed config.

## Dependencies

- TASK-216

## Verification

Use deterministic host/protocol fixtures and disposable project directories. Run focused contract and integration checks (`flutter analyze`, `flutter test`, the core host tests). For UI changes, build the affected app and inspect fresh captures. Prove regression guards fail on the broken behaviour. Real relay hosting is an explicit opt-in; record real-service evidence separately from mocks. Never run a Praxis write path against this repository's plans.

## Completion evidence

Implemented as `packages/mobile-relay` (`@praxis/mobile-relay`, `src/relayServer.ts`, `src/cli.ts`; start with `PORT=8787 npm start --workspace=@praxis/mobile-relay`, optional `TLS_CERT`/`TLS_KEY`).

- Hosts prove a channel with an Ed25519 signature over a per-connection nonce; the channel id is the first 128 bits of the SHA-256 of that key. Phones and hosts connect outbound; the relay pairs them per phone (`/v1/connect` → `incoming` → `/v1/accept`) and forwards bytes.
- Limits: channels, devices and pending connections per channel, sockets and connects per address, auth and accept timeouts, bounded pre-attach buffering, message-size cap, per-connection byte budget, heartbeat.
- Verification: `npm test --workspace=@praxis/mobile-relay` — 15 tests pass (forged/replayed signature, guessed channel, unknown/reused conn id, caps, oversize, buffer and rate limits, host-offline cleanup, replacement, per-address rate limit, no payload/key in logs). Two mutations (signature check bypassed; buffer limit removed) each made the suite fail.
- Remaining: hosting is not chosen (TASK-216), and no TLS termination or reverse-proxy client-address handling is configured; behind a proxy the per-address limits see the proxy's address.

## Description


## Comments
