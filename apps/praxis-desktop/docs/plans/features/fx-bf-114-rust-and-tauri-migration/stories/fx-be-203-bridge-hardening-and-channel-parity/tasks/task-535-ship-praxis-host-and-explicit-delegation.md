---
**Created:** 2026-11-08T12:00:00.000Z
id: TASK-535
type: Task
status: Done
---

# Ship praxis-host in release builds and make delegation explicit

**Status:** Done
**Type:** Task
**Priority:** Critical

## Description

Make it explicit, in every build, whether the app is using Rust.

- **Packaging decision.** Either bundle `praxis-host` in the packaged app's resources (built with `cargo build --release` per target platform in `build-release.yml`, then signed and notarised alongside the app on macOS) and add that resources path to `resolveRustHostBinaryPath()`, or record a deliberate decision that release builds stay on TypeScript until a named domain is ready. Write the decision down in this task's comments.
- **Binary selection.** Prefer the newest of `target/release` and `target/debug` rather than always debug. Warn at startup when the chosen binary is older than the newest file under `crates/`.
- **Visibility.** Log the resolved mode at startup: Rust binary path and version, and the delegated channel count (or "TypeScript only" with the reason). Expose it through `host:status` for diagnostics.
- **Escape hatch.** Keep `PRAXIS_RUST_CHANNELS=none` working and document it in `apps/praxis-desktop/AGENTS.md`.

## Acceptance Criteria

- A packaged build logs which mode it runs in and why.
- If the binary is bundled, a packaged build delegates the default channel set, and the git e2e specs pass against it.
- A stale debug binary produces a visible warning instead of being used silently.

## Dependencies

- `TASK-534`

## Comments


### 2026-11-09 — explicit local selection and TypeScript release policy

Packaging decision: packaged releases stay on TypeScript until TASK-537 proves git/settings/folder parity and a subsequent release change bundles and signs the platform host binaries. No release workflow, installer, signing or notarisation changes in this task. Packaged delegation is disabled even if local Cargo binaries or environment overrides exist.

- Local source builds select the newest regular file in `target/release` and `target/debug`; release wins equal timestamps. An explicit `PRAXIS_RUST_HOST_BIN` takes precedence, and a missing/invalid override never silently falls back to a different binary. The exact selected path is pinned into the transport.
- Startup logs mode, reason, path and delegated-channel count. The lazy host's ready handshake logs its actual crate and protocol versions. Local binaries older than files under `crates/` or root Cargo manifests produce a visible warning; a failed freshness scan is also reported.
- Internal `getRustHostBridge().invoke('host:status')` includes delegation diagnostics. TypeScript-only diagnostics do not start a host. This is not a new renderer/preload API.
- Added desktop `AGENTS.md` documenting the release policy, source-run selection and `PRAXIS_RUST_CHANNELS=none` escape hatch.

Verification: main compilation and trusted IPC checks pass; `npm run test:git` passes 188/188 with localhost access. Fixtures exercise newest/tie/override/missing-file selection, crate and lockfile freshness, packaged disablement and status without dispatch. An isolated Electron application fixture (renamed executable, `app.isPackaged=true`, temporary userData) loads the actual compiled bridge singleton: it logs TypeScript mode and the parity-gate reason, and returns zero delegated channels without starting Rust. The initial unrenamed Electron fixture was classified as a source run and confirmed the real stale-binary warning and host version log instead. The final packaged fixture exits successfully. This proves the packaged policy wiring, not a built/signed Praxis installer. No UI changes or visual verification; full desktop E2E was not run.
