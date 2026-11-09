---
**Created:** 2026-11-07T21:21:15.950Z
id: TASK-520
type: Task
status: In Progress
---

# Port Ed25519 mobile pairing, LAN WebSocket host, and relay

**Status:** In Progress
**Type:** Task
**Priority:** Medium

## Description

Port `@praxis/mobile-protocol`, `@praxis/mobile-relay`, and `apps/praxis-desktop/main/src/main/mobile*.ts` into `crates/praxis-mobile`. Preserve wire compatibility with the Flutter mobile app (`apps/praxis-mobile`), including the pairing exchange, trust store persistence, command ledger idempotency, LAN-only access policies, and relay tunneling.

What the code actually does (corrected 2026-11-08; the title's "Ed25519 pairing" and "LAN WebSocket host" are inaccurate):

- **Phone ↔ desktop channel:** Noise `IK` (`Noise_IK_25519_ChaChaPoly_SHA256`) — X25519 static and ephemeral keys, IETF ChaCha20-Poly1305, SHA-256 and Noise's HMAC-SHA256 HKDF. The phone is the initiator and pins the desktop's X25519 static public key from pairing. The desktop's pairing code (UTF-8) is the Noise prologue. Ed25519 plays no part in pairing.
- **LAN listener:** a plain TCP socket (`net.createServer`), not a WebSocket. Records are 4-byte big-endian length-prefixed, at most 1 MiB, and handshake messages and transport ciphertexts are framed the same way. Each transport record carries one JSON frame: requests `{id, kind: read|command|replay|pair, payload}`; replies `{id, kind:"reply", ok, value?, code?, error?}`; events `{kind:"event", envelope:{sequence,…}}`; statuses `{kind:"status", status:{code, message, retryable}}`. An unknown phone gets `pairing-required` and presents its invitation token in a `pair` frame (`{tokenId}`).
- **Relay:** WebSockets. **Ed25519 is only used here:** the host signs `"praxis-relay-v1|" + nonceHex` to claim channel `sha256(rawPublicKey)[0..16]` as hex. The relay pipes opaque bytes; the Noise channel runs end to end above it.

## Acceptance Criteria

- All mobile protocol, pairing handshake, trust store, command ledger, and LAN policy unit tests pass in `cargo test -p praxis-mobile`.
- `mobileAccess.spec.ts` passes and wire frames remain 100% compatible with `apps/praxis-mobile`.

## Dependencies

- `TASK-514`

## Comments

**2026-11-08 — slice 1 (protocol + relay) done on branch `worktree-agent-af7bd3011c78c3528`.**
- `crates/praxis-mobile` now ports `packages/mobile-protocol` (`noise.rs`, `secure_channel.rs`, `wire.rs`, `client.rs` as an async tokio client over any `AsyncRead + AsyncWrite`, `session_mirror.rs`) and `packages/mobile-relay/src/relayServer.ts` (`relay.rs`, axum). New workspace deps: `x25519-dalek`, `chacha20poly1305`, `hmac`, `zeroize`, `getrandom`, `futures-util`.
- Interop is proven byte for byte against the compiled TypeScript (`tests/fixtures/ts_vectors.json`, `ts_relay_vectors.json`). The vectors come from fixed static and ephemeral keys, injected through the TS `ephemeralKeyPair` hook, and cover the framed IK handshake messages (with and without a prologue and payloads), every transport record in both directions together with its JSON, the handshake hash, rekey, framing, status defaults, transport-failure messages, and a Node-signed relay challenge with its channel id. The canonical `snow` IK/NK/XX vectors also pass. Every TS test in `client`/`noise`/`secureChannel`/`relayServer` has a Rust port.
- Deliberate differences from the TS: the reserved nonce 2^64-1 is refused for messages (the TS allows one message on it); an unknown status code becomes a `protocol-error` (in the TS it throws uncaught inside the socket handler); short or truncated handshake messages are errors, not short-key slices; relay signatures use strict Ed25519 verification; the relay does not build in TLS.
- Open (later slices): the desktop host side, `apps/praxis-desktop/main/src/main/mobile*.ts` (LAN server, pairing registry and trust store, permissions and LAN policy, command ledger, relay client, projections), and the `mobileAccess.spec.ts` acceptance criterion.


**2026-11-09 — slice 2 checkpoint (desktop foundations and projections).**
- Host foundations: typed read/command dispatch and capability checks, bounded command/event ledger, LAN access policy and listener lifecycle abstraction, pairing invitations and trusted-device registry, host identity behind a secret-store interface, and permission answering. Pairing persistence retains the TypeScript JSON shape.
- Projection slice: session summaries/snapshots (bounded history, streaming response, permission prompts, gadget publication keys and handover-brief suppression), workflow run snapshots/current-stage selection, project-scoped event envelopes, relative changed-file lists and bounded diffs behind an injected Git interface, plus gadget answer text helpers. The existing TypeScript projection tests are ported.
- Verification: `cargo test -p praxis-mobile --locked` passes 125 unit tests and 9 protocol/relay integration tests; `cargo clippy -p praxis-mobile --all-targets --locked -- -D warnings` passes. These are crate-level checks, not the desktop `mobileAccess.spec.ts` criterion.
- Known string boundary difference: Rust replaces an isolated UTF-16 surrogate with U+FFFD if a text cap cuts through an emoji; TypeScript JSON can preserve that lone surrogate. Ordinary UTF-16 cut positions match.
- Still open: the actual LAN socket/Noise responder composition, desktop relay client, host-service adapters/composition, mobile scheduled-run handlers and live host integration. Saved `services.rs` and `scheduled_runs.rs` drafts remain unregistered and uncommitted. No mobile IPC channel has moved to Rust. TASK-520 stays In Progress; desktop e2e and live mobile interoperability remain gated by FX-BE-203.
