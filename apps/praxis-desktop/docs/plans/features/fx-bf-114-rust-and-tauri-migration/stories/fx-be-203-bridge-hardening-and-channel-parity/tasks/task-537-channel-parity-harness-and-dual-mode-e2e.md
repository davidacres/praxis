---
**Created:** 2026-11-08T12:00:00.000Z
id: TASK-537
type: Task
status: In Progress
---

# Build the Rust/TypeScript channel parity harness and dual-mode e2e runs

**Status:** In Progress
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


### 2026-11-09 — channel parity harness implemented

Added `main/src/main/rustChannelParity.test.ts` and `npm run test:rust-parity` in the desktop-main workspace. The existing `test:git` command now includes the harness, so the current CI git-test step picks it up without a new workflow or a triggered CI run. A compiled Rust host is required; missing binaries fail instead of skipping proof.

- Captures the actual registered Git/folder TypeScript fallback closures and invokes the Rust handlers over `StdioRustHostTransport`. Settings reads compare against the actual `SharedSettingsBackend` cache; read-only settings RPCs must preserve the input JSON data.
- Covers every one of the 35 current defaults: all 33 Git channels, `settings:get`, and `folder:discoverPlans`. The final coverage assertion requires an exercised scenario for every default, so new channels cannot silently lack a fixture.
- Independent temporary roots contain deterministic Git identities/dates, commit history, tags, branches, dirty/untracked files, index changes, conflict stages, stash/pop and local bare remotes. Push, fetch and pull transfer new commits; no network credentials or real repositories are used. Hooks are redirected to a new empty temporary directory.
- Mutating results compare working file bytes, index entries, staged patches, porcelain status, refs/history and bare-remote refs, in addition to response shapes. Only fixture-root locations and `generatedAt`/`loadedAt` response timestamps are normalized; commit hashes and dates remain checked.
- Settings include malformed fields and legacy surface/subnet inputs. Folder discovery uses a duplicate multi-root connection and a temporary plans tree with board configuration and a nested typed story. No Praxis write path targets the checkout.

Verification: desktop compilation/trusted IPC checks and the integrated git suite pass 224/224 (including 35 channel subtests and their coverage test). The dedicated parity command passes 36/36 after adding explicit legacy settings inputs. Restricted watcher access failed in the first run; reruns with the required filesystem/localhost access passed. Initial apparent Git mismatches were fixture errors (wall-clock response metadata and a symbolic commit selector unsupported by the TS commit-details handler); no production behavior was changed to make parity pass.

Scope: this completes the channel-harness suggestion, not the entire bridge gate. Still open in TASK-537: the 10,000-event renderer delivery proof, dual-mode desktop E2E/CI wiring, and the migrated-domain checklist. Shared-file coordination and cache/notification proof are required before enabling Rust settings writes. Desktop E2E, visual verification and a remote CI run were not performed for this test-only slice. TASK-537 remains In Progress.

### 2026-11-09 — streaming and dual-mode desktop proof complete locally

- `rustEventStream.spec.ts` emits 10,000 ordered events through the real Rust HostEventBus/stdio transport, Electron bridge, preload and both main/secondary renderer windows. Both receivers match every sequence exactly. The test also proves host restart, subscription removal and delivery after the secondary window closes. Result: 1/1 passed, no mocked renderer.
- `npm run test:rust-dual-mode` in desktop-main builds Rust, shared declarations and renderer, copies the renderer, compiles main, and runs gitGraph, gitOnboarding, settingsReset, folder, folderMulti, editIssue and newIssue serially in TypeScript then default Rust mode. Result: 23/23 in each mode, 46 total. Launcher diagnostics assert the actual mode, exact delegated set and a real Rust ready/version response. Settings writes remain on TypeScript in both modes.
- Added the migrated-domain definition to desktop AGENTS.md. Local results are not a substitute for CI or a release run.
- Prepared the first workflow read (`workflows:listPolicies`) in Rust and wired the existing IPC through `handleOrFallback`; it is opt-in only and absent from defaults. Eight real-host parity tests cover missing/corrupt stores, sparse/unknown records and acknowledged TS saves/removals without writes. The actual Policies page passes 2/2 E2E tests with the sole explicit workflow channel enabled. A fresh inspected capture is retained at `.praxis/session-artifacts/task537-workflow-policies-rust.png`.
- Fixed a routing bug found by opt-in testing: mode flags remain case-insensitive, but explicit camel-case channel names are preserved rather than lowercased. Regression assertions cover `workflows:listPolicies`, `git:getCommit` and `NONE`.
- Broader verification: 232/232 desktop git/bridge/default-channel/workflow parity tests; 945/945 Rust workspace tests; `check:rust` (fmt/check/clippy/contracts) passes. No UI source or pixel baselines changed. Full functional/theme suites were not run; focused real desktop flows above were.

Still open: matching remote CI evidence and CI workflow wiring. The attempted on-demand workflow write was rejected by automatic approval review, citing the initial planning-only instruction and future Actions resource use; no active workflow was added or triggered. A review-only proposal is preserved at `.praxis/session-artifacts/rust-bridge-ci-proposal.md`. GitHub auth works with network access, but the existing remote runs do not match the local commits. No push was performed. TASK-534 and FX-BE-203 must not be closed on this local evidence alone.

The opt-in workflow read is not a completed default cutover: TypeScript's policy cache may expose an unacknowledged save before Rust's durable-file read sees it. That concurrency contract must be settled and the gate must pass before default routing changes. No TypeScript implementation was deleted.
