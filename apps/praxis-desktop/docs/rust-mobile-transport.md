# Rust mobile transport checkpoint

2026-11-09. Continues the [host-service draft handoff](rust-mobile-host-handoff.md) from `432f32d6`. The Rust library now contains a running TCP/Noise responder and outbound relay client. Desktop dependency adapters and IPC cutover remain open under TASK-520.

## Implementation and boundaries

- `crates/praxis-mobile/src/host/lan_server.rs` binds explicit private/local addresses from a trusted OS interface inventory supplied by the desktop adapter. It filters the chosen interfaces, uses one selected port across the addresses, rolls back failed binds, and releases listeners and peers on stop/drop. Interface discovery itself stays in the platform adapter; the inventory is not phone-supplied data.
- Each accepted stream runs the framed Noise IK responder with the pinned host identity and optional pairing prologue. Pending peers have deadlines and global/per-address limits; known and pending sockets share a 128-peer cap. Unknown keys fail closed without an authorizer/pairing callback. Pairing status, token presentation, desktop promotion, refusals and device/key revocation work on the established socket.
- The host replaces caller claims with the authenticated device grant, enforces allowed project ids before dispatch, filters project discovery, and applies the same project filtering to live and replayed events. Host appearance events remain host-wide. Policy restrictions are rechecked for established connections. Replay reports retention truncation and new peers start at the live cursor.
- Requests can run concurrently on one phone so a long command does not block other requests. At 32 outstanding requests per peer the listener applies stream backpressure. Revoking a socket closes it promptly; already admitted handlers finish and record their command outcomes, matching TypeScript's in-flight mutation behavior. Command-id admission is now atomic because separate Rust tasks can execute on different threads.
- `host/relay_client.rs` signs the relay challenge with Ed25519, verifies the registered channel, accepts incoming streams, reports state, reconnects with bounded exponential backoff, and cancels reconnect/pending/established streams when stopped. Relay URLs require WSS except for loopback WS. WebSocket messages are adapted to a bounded byte stream; Noise framing and encryption remain end to end.
- The host services, device authorizer, invitation registry callbacks and event ledger are injected. The real desktop must still compose them with its running projects, sessions, workflow stores, permissions, secrets and settings. No mobile delegation channel was enabled by this slice.

## Fresh evidence

| Check | Observed result |
| --- | --- |
| `cargo test --workspace --locked` | 974 passed, 0 failed, 1 ignored. Includes 154 mobile unit tests and 9 protocol/relay integration tests. The ignored test requires the built TypeScript phone package and is explicitly run below. |
| Explicit real TypeScript phone test | 1 passed, 0 ignored. The compiled TypeScript client successfully connected to the Rust TCP responder and to the Rust responder through its outbound relay client and the Rust relay server. |
| `cargo clippy -p praxis-mobile --all-targets --locked -- -D warnings` | Passed. |
| `cargo build -p praxis-host --locked` | Passed. |
| Rustfmt check for the new transports and ledger | Passed, including their test modules. |

The 19 ordinary transport tests cover identity replacement, capability denial, project filtering, pairing promotion/refusal, wrong host keys and prologues, live/replayed events, truncation, revocation, shutdown, pending limits/expiry, malformed/oversized records, fragmented handshake input, resource cleanup, concurrent command admission, long-running handlers, relay registration, access modes, stop and reconnection. The cross-language test also exercises commands/retries and checks captured wire bytes for tested plaintext markers, with a positive detector control. This is local interoperability evidence, not an exhaustive information-flow proof or a Flutter device run.

The fresh TypeScript proof uses `tests/fixtures/host_transport_client.cjs`, the actual compiled `@praxis/mobile-protocol` client and a Node TCP/WebSocket connector. The dependency checkout supplies the installed npm packages; no fresh TypeScript build is claimed. Reproduce it after building that package:

```sh
PRAXIS_TS_WORKSPACE=/path/to/dependency-checkout cargo test -p praxis-mobile --locked real_typescript_phone_interoperates -- --ignored --nocapture
```

## Remaining integration

TASK-520 remains In Progress. Wire the desktop's real service/authorization/pairing/event/lifecycle adapters to this transport and provide its OS interface snapshot. Preserve permission ownership, workspace trust, safe file/image reads, schedule notifications and runner wake-up from the existing TypeScript composition.

The earlier 110 TypeScript mobile tests and 4 desktop mobile-access checks remain baseline evidence from the draft handoff; they were not rerun here and do not exercise Rust mobile delegation. Fresh dual-mode desktop tests with diagnostics proving the mobile runtime, real Flutter interoperability, remote CI, full desktop/theme suites, release packaging/signing and packaged delegation remain unproven. No UI code or snapshots changed and no visual verification was performed in this slice.
