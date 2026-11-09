# Desktop Rust backend selection

Packaged releases deliberately use TypeScript until TASK-537 proves domain parity and a later release change adds signed platform host binaries. Do not infer release readiness from local Rust tests.

For source runs, `PRAXIS_RUST_CHANNELS=none` disables Rust delegation. Unset it to restore defaults, or use `git:*` to select that domain. Local selection uses the newest `target/release/praxis-host` or `target/debug/praxis-host` (release wins ties). `PRAXIS_RUST_HOST_BIN` overrides local selection; an invalid override does not silently select another binary. Packaged releases ignore these overrides for delegation.

Startup logs explain the selected mode, reason, binary path and channel count. The ready handshake logs the actual host version when the lazy process starts. A binary older than files under `crates/` or root Cargo manifests generates a warning. `getRustHostBridge().invoke('host:status')` exposes delegation diagnostics; TypeScript-only status does not start Rust. Internal diagnostics are not a renderer IPC API.

## Definition of a migrated domain

A channel group counts as migrated only when:

1. Every channel is delegated with a passing parity check, or deliberately remains in Electron.
2. Validation, events, cache updates and other TypeScript side effects are inventoried and retained in Rust or explicit TypeScript pre/post steps.
3. Its Playwright specs pass in CI with `PRAXIS_RUST_CHANNELS=none` and the default Rust set, with diagnostics proving which channels each mode exercises.
4. It has shipped on Rust in a release build before its TypeScript implementation is deleted.

A local unit/parity run or an opt-in handler is preparation, not evidence that this gate has passed. Settings writes remain in TypeScript until shared-file coordination and cache/notification parity are proven.
