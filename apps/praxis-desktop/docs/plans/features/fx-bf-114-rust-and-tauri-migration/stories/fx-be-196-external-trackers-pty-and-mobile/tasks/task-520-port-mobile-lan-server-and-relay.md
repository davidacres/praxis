---
**Created:** 2026-11-07T21:21:15.950Z
id: TASK-520
type: Task
status: To Do
---

# Port Ed25519 mobile pairing, LAN WebSocket host, and relay

**Status:** To Do
**Type:** Task
**Priority:** Medium

## Description

Port `@praxis/mobile-protocol`, `@praxis/mobile-relay`, and `apps/praxis-desktop/main/src/main/mobile*.ts` into `crates/praxis-mobile` using `ed25519-dalek` and `tokio-tungstenite`. Preserve wire compatibility with the Flutter mobile app (`apps/praxis-mobile`), including pairing QR handshake, trust store persistence, command ledger idempotency, LAN-only access policies, and relay tunneling.

## Acceptance Criteria

- All mobile protocol, pairing handshake, trust store, command ledger, and LAN policy unit tests pass in `cargo test -p praxis-mobile`.
- `mobileAccess.spec.ts` passes and wire frames remain 100% compatible with `apps/praxis-mobile`.

## Dependencies

- `FX-BE-195`

## Comments


