# Rust mobile transport checkpoint

2026-11-09. Continues the [host-service draft handoff](rust-mobile-host-handoff.md) from `432f32d6`, committed as `bae0753e` and integrated into local `main` by fast-forward. The Rust library now contains a running TCP/Noise responder and outbound relay client. Desktop dependency adapters and IPC cutover remain open under TASK-520.

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

## Decision: transport-only adapter (2026-11-09)

Chosen design: Rust owns Noise/TCP/relay; decoded, identity-stamped requests are forwarded to the existing TypeScript `MobileHostApplication`. The Rust service drafts stay dormant until a later cutover.

Findings that shape the work:
- `HostWireFrame` (`crates/praxis-host/src/stdio.rs`) has only `Ready`/`Response`/`Event`, and the host reads only `RustRpcRequest` lines, so there is no host-to-Electron request path. Forwarding needs new `HostCallRequest` (host to Electron) and `HostCallResponse` (Electron to host) frames, with id correlation, timeouts and cancellation on shutdown.
- `MobileLanServerDeps` takes an injected `MobileHostApplication`; the Rust-side app handlers become thin proxies over those frames. Authorizer, pairing and unpaired-peer callbacks (`mobileAuthorizePeer`, `mobileOnUnpairedPeer`) and the event feed need the same treatment.
- Control surface needed from Electron: start/stop with interface inventory and port, `apply_policy`, `drop_device`/`drop_public_key`, `promote_pending`, relay start/stop and state.
- A TypeScript adapter exposing the `MobileLanServer`/`MobileRelayClient` surface used by `mobileListenerInstance.ts` and `mobilePairingInstance.ts` lets selection stay a single switch (default TypeScript, opt-in env var, as with `PRAXIS_RUST_CHANNELS`).

Planned slices: (1) reverse-call frames plus tests; (2) host control methods and proxy handlers; (3) TypeScript adapter and opt-in selection; (4) dual-mode desktop tests proving which runtime served and the real-phone interop test through the adapter.

### Slice 1 done: host-to-Electron call channel

- Rust: `HostWireFrame::Call`, inbound `HostInboundReply::CallResponse` and `HostCallClient` (`crates/praxis-host/src/call_client.rs`) give correlated ids, per-call timeouts, late-reply tolerance, failure on a dead write, and `close()` that fails outstanding and future calls. The binary routes `callResponse` stdin lines to the client (all other lines still parse as `RustRpcRequest`, so existing traffic is unchanged) and closes the client at stdin EOF.
- TypeScript: `StdioRustHostTransport` takes an `onCall` handler; without one, calls are refused immediately rather than timing out; handler errors become `ok:false`.
- Evidence: 6 new Rust unit tests; 3 new Node tests (`rustHostCalls.test.ts`, added to `test:mobile`) using a stand-in host process; full Rust workspace 980 passed, 0 failed; clippy `-D warnings` clean; existing `rustHostBridge` and `rustChannelParity` Node tests 51/51 against the rebuilt real binary.
- Not yet proven: the real `praxis-host` binary never issues a call (nothing uses the channel yet), so the Rust-to-Node path is covered by each side's tests against the shared wire shape, not an end-to-end run. Slice 2 supplies the first real caller.

### Slice 2 done (LAN): bridge controller and proxy handlers

`crates/praxis-host/src/mobile_bridge.rs`, wired into `praxis-host --stdio` (multi-thread tokio runtime; the stdin loop stays on the main thread).

- `proxy_application` registers a handler for every `MobileReadOperation` / `MobileCommandOperation` that forwards the identity-stamped request to Electron as `mobile.read` (30 s) / `mobile.command` (120 s). Command-id admission and replay run in the Rust ledger on this transport.
- Pairing is asked of Electron synchronously at handshake: `mobile.authorizePeer` (grant or null) and `mobile.unpairedPeer` (connection status). Both use `block_in_place` on the listener worker with a 5 s timeout and fail closed (no grant / `access-disabled`). No device table is mirrored, so revocation takes effect on the next handshake without staleness.
- Control channels: `mobile:start` (port, policy, interface addresses, hex host private key, optional pairing code; a new key replaces the server), `mobile:stop`, `mobile:status`, `mobile:applyPolicy`, `mobile:dropDevice`, `mobile:dropPublicKey`, `mobile:promote`, `mobile:appendEvent` (Electron feeds the event log with its own sequence numbers). They are not in `DEFAULT_MIGRATED_CHANNELS`; the slice 3 adapter calls them on the transport directly.
- Evidence: 3 new integration tests with a real `MobileSecureClient` over TCP and a stand-in Electron: forged caller claims are replaced before Electron sees them; an out-of-grant project never reaches Electron; a retried command is forwarded once and replays; unknown peers get Electron's pairing status and cannot read; bad keys are rejected and control calls are safe with no server. Workspace: 983 passed, 0 failed; clippy `-D warnings` and `cargo fmt --check` clean; 54/54 existing/new Node bridge tests; the rebuilt real binary answers `mobile:status`.
- Relay was completed in slice 2b below. Not done: IPv6 scope ids are not carried in `mobile:start`; no end-to-end run against the real TypeScript application yet (slice 3/4).

### Slice 2b done: relay bridge

- `mobile:relayStart` {relayUrl, relaySigningKey, hostPrivateKey, pairingCode?} runs the Rust outbound relay client and hands every relayed stream to the same listener (`relay_route` context, so the `internet` access mode still gates it after the Noise handshake). `relaySigningKey` is the hex PKCS#8 DER already kept by the TypeScript secret store, so the channel id is unchanged when switching runtimes. The same URL is idempotent; a different URL replaces the connection; `mobile:relayStop` and host-key rotation (server replacement) stop the old connection. `mobile:status` includes the relay snapshot.
- Every relay state change is pushed to Electron as the host call `mobile.relayState` {state, channel, error} so the pairing UI can publish the route.
- Evidence: 2 new integration tests (5 total in `tests/mobile_bridge.rs`): a real phone connects through the real Rust relay server and the bridge, reaches Electron with the paired identity, the registered channel is reported via `mobile.relayState`, and `relayStop` reports `stopped`; plain `ws:` to a remote host and non-Ed25519 keys are refused with no relay left running. Workspace 985 passed, 0 failed; clippy `-D warnings` and `fmt --check` clean with `--locked`; the rebuilt binary answers `mobile:relayStop`. The tests caught a real self-deadlock (re-locking the relay mutex in the idempotent path), fixed before commit.
- `Cargo.lock` gained the `tokio-tungstenite` dev-dependency edge for `praxis-host`.
- Still open: relay `on_log` is not forwarded to Electron's log bus; a real relay deployment (wss) was not exercised, only loopback ws.

### Slice 3 done: opt-in desktop adapter

`main/src/main/rustMobileTransport.ts` implements the awaitable listener/relay controls used by the desktop composition. It uses the committed `--stdio` reverse-call bridge in a dedicated child process; the existing general IPC delegation bridge keeps its own process and channel selection. No renderer IPC control channel was added.

- Enable source runs with `PRAXIS_MOBILE_TRANSPORT=rust` after building `praxis-host` and desktop main. The default is TypeScript. Packaged builds and `PRAXIS_RUST_CHANNELS=none` / `false` / `0` / `off` always select TypeScript. `PRAXIS_RUST_HOST_BIN` retains the existing explicit binary selection semantics. A failed Rust selection does not fall back to TypeScript.
- Rust owns TCP/Noise, relay streams, authenticated identity replacement, project filtering, and command admission/replay. `mobile.read` uses TypeScript `handleMobileRead`; `mobile.command` uses `dispatchMobileCommand`, preserving the existing services, capability checks, permissions, workspace trust, gadget checks and schedule side effects without adding a second command ledger. Pairing callbacks use the existing registry and return `null` for an unknown key.
- Electron supplies the OS interface inventory and mirrors retained/live events from its authoritative event ledger, in sequence, every 100 ms. Event copies cannot overlap. Listener state is polled on the same interval; relay state callbacks and polling update the existing pairing route. Keys travel only over the private child pipe. Ready status and transport/relay selection are logged.
- Settings changes and listener recreation are serialized. Pairing operations await remote promotion, denial and revocation; the new `mobile:dropAll` control preserves `host-key-reset` on the phone. Key rotation disposes the old adapter/relay before rebuilding them. The app quit hook requests mobile cleanup; child pipe closure also releases the host. This is not proof of graceful completion of every in-flight mutation on app exit.
- Identity reads now share an in-flight load and wait behind rotation, preventing status refreshes from restoring the old cached key during secret deletion. The earlier uncommitted adapter draft identified this case; a deterministic regression and an actual Electron key-reset/rebind test now cover the fix on this bridge design.
- Control requests have a 10-second deadline. Transport loss or a deadline failure closes the child and latches an error. Further controls fail until the adapter is recreated, rather than silently starting a host with an empty command ledger. No command is retried through TypeScript on a transport failure.

Fresh local verification for this slice:

| Check | Result |
| --- | --- |
| Desktop main compile and trusted IPC sender check | Passed. |
| Full TypeScript mobile suite, `PRAXIS_TEST_RUST_MOBILE=1 npm run test:mobile` | 125 passed, 0 failed/skipped. Four existing phone/service scenarios run through the real Rust adapter in this mode; the new adapter tests also exercise a real relay, pending pairing/promotion, caller replacement, project denial, command replay, revocation and key-reset status. Stand-in control tests cover mapping, capability rejection, process loss and timeout refusal. |
| Existing stdio bridge, default-channel parity and reverse-call tests | 54 passed against the rebuilt real host. |
| `cargo test --workspace --locked` | Passed, with the one optional TypeScript interop test still ignored by the default Rust suite. The new Node tests exercise the real TypeScript phone client through this adapter over TCP and relay; the separate optional Rust test was not rerun. |
| Host build, host all-target Clippy with `-D warnings`, workspace `cargo fmt --all --check` | Passed with `--locked` for build/Clippy. |
| Focused Electron `mobileAccess.spec.ts` | 5 passed in each transport mode. Each run asserts the selected transport in the main-process log; tests cover off state, enabling/listening/discovery, invitation/QR creation, reset confirmation, actual fingerprint rotation/rebinding and subnet validation. |
| Visual inspection | Opened the retained Rust-mode screen after listener enablement and invitation creation. Listening/discovery state, fingerprint, pairing code and QR were visible. Evidence: `.praxis/session-artifacts/rust-mobile-transport.png`. No UI layout or snapshot baseline was changed. |

These are local adapter checks, not a completed mobile-domain migration. Slice 4 remains open for a full real-desktop phone request/command scenario (including schedule and approval effects), physical Flutter interoperability and matching remote CI evidence. The full desktop functional/theme suites and broad smoke suite were not run for this backend slice; the renderer was not changed, and its existing production build was copied before Electron checks rather than freshly rebuilt.

Known bridge limitations remain explicit: Rust owns an independent command ledger from mobile IPC; recreation/key rotation resets that Rust ledger. A command still executing in Electron after the 120-second reverse-call deadline can finish after Rust has recorded an unknown outcome, and the current bridge cannot recover that late outcome on retry. Keep a phone on one runtime and do not treat this experimental adapter as release-ready until command outcome ownership/recovery is resolved. Numeric IPv6 link-local scope ids are not yet accepted by `mobile:start`; the adapter excludes link-local IPv6 addresses and uses the other eligible local addresses. Real WSS deployment, raw Rust relay log forwarding, signed host packaging and packaged delegation remain unproven.

A different, uncommitted `--mobile-stdio` adapter draft is preserved in `/private/tmp/praxis-mobile-host` on `codex/mobile-host` at `2c321f78`. Its documentation reports earlier checks, but those are not fresh evidence for the committed bridge design used here. Its alternative command-ledger design and IPv6 handling should be reviewed when closing the remaining gates; it was not merged or deleted.
