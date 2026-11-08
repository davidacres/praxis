---
**Created:** 2026-11-08T12:00:00.000Z
id: TASK-535
type: Task
status: To Do
---

# Ship praxis-host in release builds and make delegation explicit

**Status:** To Do
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

