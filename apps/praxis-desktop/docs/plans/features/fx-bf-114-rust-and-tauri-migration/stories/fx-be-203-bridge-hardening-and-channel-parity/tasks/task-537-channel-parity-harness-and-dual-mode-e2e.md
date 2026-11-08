---
**Created:** 2026-11-08T12:00:00.000Z
id: TASK-537
type: Task
status: To Do
---

# Build the Rust/TypeScript channel parity harness and dual-mode e2e runs

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Give every delegated channel a test that checks Rust and TypeScript return the same result.

- **Parity harness.** A `node --test` suite that, for each delegated channel, calls the TypeScript fallback and the Rust handler (through `StdioRustHostTransport`) with the same fixtures. It compares the results with normalisation for key order, timestamps and absolute temp paths. Fixtures cover a git repository with history, conflicts and stashes; a settings file with legacy and invalid fields; and a plans tree with `board.praxis.json` and nested stories. Channels with side effects compare the state on disk afterwards as well.
- **Dual-mode e2e.** Add a script that runs a domain's Playwright specs twice, once with `PRAXIS_RUST_CHANNELS=none` and once with the default set. Wire it into CI for git, settings and folder, so CI covers the Rust path (it needs the binary from `TASK-534`).
- **Streaming events.** Prove `HostEventBus` events travel through the bridge to the renderer in order and without loss under load, using a synthetic `host:emitEvent` stream. FX-BE-197's `workflows:runChanged` and `runs:logEvent` depend on this, as does FX-BE-198's streaming chat turns.
- **Cutover checklist.** Add the "Definition of a migrated domain" from `FX-BE-203` to `apps/praxis-desktop/AGENTS.md`, so later stories follow it.

## Acceptance Criteria

- The parity harness passes for every channel in `DEFAULT_MIGRATED_CHANNELS`.
- Git, settings and folder e2e specs pass in both modes.
- The synthetic event stream test delivers 10,000 events in order with none dropped.

## Dependencies

- `TASK-535`
- `TASK-536`

## Comments

