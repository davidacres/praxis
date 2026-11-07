---
**Created:** 2026-11-07T21:20:26.706Z
id: TASK-510
type: Task
status: Done
---

# Initialize root Cargo workspace and shared lints

**Status:** Done
**Type:** Task
**Priority:** Critical

## Description

Create the root `Cargo.toml` workspace alongside `package.json` with member crates (`praxis-contracts`, `praxis-core`, `praxis-trackers`, `praxis-workflows`, `praxis-ai`, `praxis-mobile`, and `praxis-host`). Configure workspace-wide dependencies (`serde`, `tokio`, `reqwest`, `specta`, `pulldown-cmark`, `notify`, `portable-pty`, `ed25519-dalek`, `napi` / `napi-derive`), `rustfmt.toml`, and Clippy lints, and wire `cargo test --workspace` into root npm scripts.

## Acceptance Criteria

- `cargo check --workspace` and `cargo clippy --workspace -- -D warnings` pass.
- All member crate skeletons compile cleanly with shared workspace dependency versions.

## Dependencies

None

## Comments


