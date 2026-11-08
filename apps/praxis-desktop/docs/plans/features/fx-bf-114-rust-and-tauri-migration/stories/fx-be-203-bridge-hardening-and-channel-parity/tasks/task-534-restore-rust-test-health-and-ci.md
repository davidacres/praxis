---
**Created:** 2026-11-08T12:00:00.000Z
id: TASK-534
type: Task
status: In Progress
---

# Restore Rust workspace test health and add Rust tests to CI

**Status:** In Progress
**Type:** Task
**Priority:** Critical

## Description

`cargo test --workspace` did not compile. `crates/praxis-ai/src/team_chat/transitions.rs` defined the same `mod tests` nine times (E0428), and that stopped every other crate's tests from running in the same command. Collapse them into one, make the suite reliable under parallel load, and run it in CI.

CI already type-checks and lints Rust: the `Typecheck` step runs `npm run check-types`, which runs `check:rust` (`scripts/cargo-workspace.mjs check`). What it lacked was `cargo test` and a format check. Add both to the existing `build` job rather than a separate workflow. A macOS/Windows matrix and a `target/` cache are left for later, because each costs Actions minutes. Do not trigger CI runs while developing this: ask first, because Actions minutes cost money.

## Acceptance Criteria

- `cargo test --workspace` passes locally, with no crate skipped, across repeated runs.
- `cargo fmt --all --check`, clippy with `-D warnings`, and the contracts export check pass.
- The `build` job runs the Rust tests, and passes on its first run once the user triggers it.

## Dependencies

- `FX-BE-195`

## Comments

- 2026-11-08: Done locally, waiting on the first CI run.
  - **Test compile.** Kept one of the nine identical `mod tests` blocks in `team_chat/transitions.rs`.
  - **Port bug.** One real bug was hiding behind the compile error. `mcp/transport.rs` printed the truncation notice as `70000 characters`, while `mcpToolBridge.ts` prints `70,000` (`toLocaleString()`). A `group_thousands` helper now matches the TypeScript.
  - **Flaky tests.** Repeated workspace runs exposed two races:
    - Temp-repository helpers in nine `praxis-core`/`praxis-trackers` test modules named folders by process id plus a timestamp. macOS clocks tick in microseconds, so parallel tests could share a folder (seen as `git_worktree_manager::second_run_can_start…` failing about 1 run in 3 under load). Each helper now adds an atomic counter, as `praxis-workflows/src/test_support.rs` already did.
    - `praxis-host`'s `folder_and_plans_rpc_channels_roundtrip` compared two `ensureFrontMatter` results that each carry a millisecond `**Created:**` stamp. It now compares them with that line removed.
  - **Clippy.** Fixed the clippy errors in the uncommitted `praxis-ai` and `praxis-host` drafts: `Iterator::find`, `read_dir().flatten()`, and `expect` with messages instead of `unwrap` in tests.
  - **Formatting.** `cargo fmt` reformatted the committed `providers/wire.rs`.
  - **CI.** `check:rust` now starts with `cargo fmt --all --check`. `build.yml` gained a "Rust workspace tests" step (`npm run test:rust`) before the desktop git tests. That step also builds `praxis-host`, so `rustHostBridge.test.js` runs against a real host in CI.
  - **Verification.** Eight consecutive `cargo test --workspace` runs: 530 passed, 0 failed. `npm run check:rust` passes. `npm run test:desktop:git`: 183 of 183 pass. The workflow YAML parses.
  - **Still open.** The first CI run of the new step has not happened; it needs to be triggered or pushed.
