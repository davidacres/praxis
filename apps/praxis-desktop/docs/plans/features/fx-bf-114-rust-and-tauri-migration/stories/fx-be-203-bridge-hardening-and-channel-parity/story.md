---
**Created:** 2026-11-08T12:00:00.000Z
id: FX-BE-203
type: Story
status: To Do
---

# Harden the Electron-to-Rust Bridge and Prove Channel Parity

**Status:** To Do
**Type:** Story
**Priority:** Critical

## Description

Waves 1 and 2 built the bridge and ported git, settings, and the folder backend, but nothing in Rust serves real users yet, and the bridge cannot tell us when a delegated channel behaves differently from the TypeScript it replaces. This story makes the bridge trustworthy before any Wave 3 domain is cut over.

What the 2026-11-08 investigation found:

- **Release builds never delegate.** `resolveRustHostBinaryPath()` (`main/src/main/rustHostBridge.ts`) only looks in `target/debug`, `target/release`, or `PRAXIS_RUST_HOST_BIN`. Its doc comment mentions packaged resources, but that lookup does not exist, and no packaging step copies `praxis-host`. `resolveInitialMigratedChannels()` then quietly returns an empty list, so production is 100% TypeScript.
- **CI never builds or tests Rust.** None of `.github/workflows/*.yml` runs `cargo`. `cargo test --workspace` currently fails to compile: `crates/praxis-ai/src/team_chat/transitions.rs` has eight duplicate `mod tests` blocks (E0428), and that stops every other crate's tests from running in the same command. Run per crate, the others pass: `praxis-core` 104, `praxis-host` 11, `praxis-workflows` 280, `praxis-trackers` 2, `praxis-contracts` 4, `praxis-mobile` 1.
- **Local delegation depends on whatever binary happens to exist.** Any `target/debug/praxis-host`, however stale, turns delegation on for git, settings and folder, and debug is checked before release. CI end-to-end runs (no binary) exercise TypeScript while local runs exercise Rust.
- **Delegating a channel drops the TypeScript work around it.** `settings:set` validates mobile subnets inside its fallback (`main/src/main/settingsIpc.ts`). When the channel goes to Rust, that validation is skipped, so invalid subnets are accepted. The `settings:changed` broadcast still arrives, because `SharedSettingsBackend` watches the file. But TypeScript readers can see stale settings until the watcher fires.
- **The migrated list overstates progress.** `DEFAULT_MIGRATED_CHANNELS` (`main/src/main/rustHostInstance.ts`) includes `folderService:*` (9), `settings:sanitize` and `host:*`. The renderer cannot reach any of them: no TypeScript handler or preload entry registers them. About 50 of the app's ~340 IPC channels are actually delegated.
- **Fallback only happens for unregistered channels.** A Rust error other than `CHANNEL_NOT_REGISTERED` reaches the renderer as-is (correct), but nothing checks that Rust and TypeScript return the same shape.

### Definition of a migrated domain

A domain (a channel prefix group) counts as migrated only when:

1. every channel in it is delegated with a passing parity check, or deliberately stays in Electron;
2. the TypeScript side effects around it (validation, events, cache updates) have been listed, and each one was moved to Rust or kept as a TypeScript pre/post step;
3. its Playwright specs pass with `PRAXIS_RUST_CHANNELS=none` and with the default set, in CI;
4. it has shipped on Rust in a release build before its TypeScript implementation is deleted.

### Cutover order this story unblocks

1. Git, settings, folder (already wired; finish them through this story).
2. `workflows:*`, `runs:*`, `scheduledRuns:*`, `deployments:*` (FX-BE-197, about 60 channels). This is the first domain that needs Rust-to-Electron events (`HostEventBus`) to carry streaming updates.
3. `ai:*`, `aiUsage:*`, `agentRuntime:*`, `gadgets:*`, `coordination:*` (FX-BE-198, about 75 channels), after streaming is proven by step 2.
4. `terminal:*`, trackers, `mobile:*` (FX-BE-196).
5. `window:`, `browser:`, `preview:`, `dialog:`, `update:` and `shell:` stay in Electron while Electron is the shell.

The stdio transport stays the default. Moving to the N-API bridge is optional and only worth doing if measured latency calls for it.

### Execution order

`TASK-534` comes first, because CI has to be green before anything else can be trusted. `TASK-535` and `TASK-536` can then run in parallel. `TASK-537` builds on both.

## Tasks

- `TASK-534` (`Critical`, Step 1) — Restore Rust workspace test health and add Rust to CI
- `TASK-535` (`Critical`, Step 2A) — Ship praxis-host in release builds and make delegation explicit
- `TASK-536` (`High`, Step 2B) — Reconcile the migrated channel list and keep TypeScript side effects
- `TASK-537` (`High`, Step 3) — Build the Rust/TypeScript channel parity harness and dual-mode e2e runs

## Acceptance Criteria

- `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` pass locally and in CI.
- A packaged build either delegates the default channel set to a bundled `praxis-host`, or records a deliberate decision to stay on TypeScript, and logs which mode it is in at startup.
- Every entry in `DEFAULT_MIGRATED_CHANNELS` has a `handleOrFallback` registration, enforced by a unit test.
- Git, settings and folder channels pass the parity harness, and their e2e specs pass in both modes.

## Dependencies

- `FX-BE-194`
- `FX-BE-195`

## Comments

