---
**Created:** 2026-11-08T12:00:00.000Z
id: TASK-534
type: Task
status: To Do
---

# Restore Rust workspace test health and add Rust to CI

**Status:** To Do
**Type:** Task
**Priority:** Critical

## Description

`cargo test --workspace` does not compile. `crates/praxis-ai/src/team_chat/transitions.rs` defines `mod tests` eight times (E0428), and that stops every other crate's tests from running in the same command. Merge those into one test module, keeping every distinct test.

Then add a Rust job to `.github/workflows/build.yml` (or a new workflow) that runs on macOS, Linux and Windows:

- `cargo build --workspace`
- `cargo test --workspace`
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- `cargo run -p praxis-contracts --bin export-types -- --check`, so the generated `ipcContracts.ts` cannot drift

Cache `~/.cargo` and `target/`. Do not trigger CI runs while developing this. Ask before dispatching anything, because Actions minutes cost money.

## Acceptance Criteria

- `cargo test --workspace` passes locally, with no crate skipped.
- The new CI job is defined and passes on its first run once the user triggers it.

## Dependencies

- `FX-BE-195`

## Comments

