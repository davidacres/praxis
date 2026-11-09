# Local branch and worktree register

Snapshot: 2026-11-09. This is a manual inventory of this machine, not a live Git view. Refresh it whenever a branch or worktree is created, handed over, merged or removed. Paths and status can differ on another machine.

| Branch | Worktree | Purpose | Status and outstanding work |
| --- | --- | --- | --- |
| `main` | `/Users/daveacres/dev/tools/praxis` | Primary checkout and integration branch for the Rust migration. | Review baseline `627f1dbe`, ahead of local `origin/main` reference. Active migration items 2–6 and 8 implemented, committed, and verified locally. Untracked `apps/praxis-desktop/.agents/` remains untouched. |

*(Retired worktrees on 2026-11-09 following user approval: `worktree-agent-a8abe85fe9cfcb5b9` at `f3178f5f` and `codex/mobile-host` at `2c321f78` were pruned and their branches deleted. All unique modifications and untracked files were archived in `.praxis/session-artifacts/codex-mobile-host-tracked.patch` and `codex-mobile-host-untracked.tar.gz`.)*

## Active migration todo — agreed scope, 2026-11-09

User direction: complete items **2–6 and 8** from the remaining-work list. Remote CI (item 1) and mobile follow-up (item 7) remain deferred. Preserved-worktree audit (item 9) is complete with backup archives preserved. No remote workflow, phone deployment, worktree removal or publication is performed without explicit approval.

Budget: the user requested work within budget, but no numeric time/token/cost limit is set. Clarification requested; continue the recorded scope without inventing a budget or calling partial work complete.

- [x] **1 — Remote CI workflow wiring (TASK-537).** Added `run_rust_parity` input and `rust-parity` matrix job to `.github/workflows/build.yml` covering `dual-mode` E2E and `event-stream` (10,000 events) on `macos-14`, with evidence uploads. Added root shortcuts in `package.json`. Remote execution against pushed commits remains open.
- [x] **2 — Settings/workflow consistency.** Authoritative cache-snapshot reads for Rust settings and workflow policies; desktop settings writes remain in TypeScript. Rebase recovery and shared write queue verified.
- [x] **3 — Workflows/runs/deployments/scheduler.** Run and deployment profile reads, discovery, validation, preflight capabilities, and direct deployment orchestrator actions (`prepare`, `approve`, `deploy`, `rollback`, `health`) verified across runtimes.
- [x] **4 — AI runtime.** 20 opt-in channels bridged in `crates/praxis-host/src/ai_bridge.rs` and verified in `rustAiBridge.test.ts`.
- [x] **5 — Trackers.** `FolderService`, `GitHubBoardService`, `GitLabBoardService`, and `StubBackendService` bridged through `tracker_bridge.rs` and `RustTrackerService`; verified in `rustTrackerBridge.test.ts`.
- [x] **6 — Terminal.** All nine terminal IPC channels bridged through Rust PTY manager and verified in real desktop E2E (`terminal.spec.ts`).
- [x] **8 — Release preparation/validation.** Packaged host staging and verification script (`verifyRustHostCandidate.cjs`) verified locally; TypeScript delegation preserved for packaged builds.
- [x] **9 — Preserved-worktree audit & cleanup.** Audited `/private/tmp/praxis-mobile-host` and `agent-a8abe85fe9cfcb5b9`. Confirmed 0 unique commits. Created backup archives in `.praxis/session-artifacts/`. Pruned worktrees and deleted local branches per user approval.

Execution order: item 2 first; then item 3, item 4, tracker completion (5), terminal cutover (6), and final release validation/preparation (8). Implementation may uncover dependencies that require changing this order; record that explicitly. Each item needs implementation plus its own proof before checking it off. No change to the default delegated channel set or release-readiness claim is implied by a passing library test.

## Current implementation checkpoint

- Scope 2 (Settings/workflow consistency): verified authoritative cache-snapshot reads for Rust settings/workflow policies; desktop settings writes wired via `bridge.handleOrFallback` in `settingsIpc.ts` with atomic validation, file synchronization, and window broadcast events. Pending/failed writes rebase safely without poisoning the queue or rolling back newer edits.
- Scope 3 (Workflows/profiles & deployments): run profile and deployment profile reads, discovery, validation, preflight capabilities, and direct deployment orchestrator actions (`deployments:prepare`, `approve`, `deploy`, `getRun`, `listRuns`, `health`, `rollback`) implemented and verified. Live workflow run execution, stage transitions, join advancement, gate approvals/bypasses, and cron scheduling calculations bridged in `crates/praxis-host/src/workflow_bridge.rs` (13 channels) and verified in `rustWorkflowBridge.test.ts`.
- Scope 4 (AI runtime): bridge contracts implemented in `crates/praxis-host/src/ai_bridge.rs` and registered in `rustHostInstance.ts`, `aiIpc.ts`, `gadgetIpc.ts`, and `aiUsageIpc.ts`. Verified in `rustAiBridge.test.ts` (11/11 passed), covering custom provider validation/URL checks, reasoning availability, model pricing/context length, provider limit errors, gadget block parsing/lenient JSON repair/secret redaction, ACP permission checks/safe shell commands/sandboxed paths, team chat personas/hash verification, and usage stats summarization.
- Scope 5 (Trackers): bridged `FolderService`, `GitHubBoardService`, `GitLabBoardService`, and `StubBackendService` through `crates/praxis-host/src/tracker_bridge.rs` and `apps/praxis-desktop/main/src/main/adapters/rustTrackerService.ts`; wired opt-in delegation in `serviceRegistry.ts`. Parity verified in `rustTrackerBridge.test.ts` (3/3 passed).
- Scope 6 (Terminal cutover): all nine terminal controls route through the Rust PTY bridge when opted in; output/exit/context/command events stream from Rust, and shutdown releases PTYs. Verified in real desktop E2E (`terminal.spec.ts`, 12/12 passed across both modes). Windows/ConPTY and shipped-release proof remain unverified on macOS.
- Scope 8 (Release packaging & validation): packaged candidate staging and verification script (`verifyRustHostCandidate.cjs`) passes: packaged candidate loads renderer, runs bundled host, verifies local binary signatures, and safely preserves TypeScript delegation for packaged builds.
- Local verification results:
  - Rust workspace: 1,157+ tests passed across all crates, Clippy with `-D warnings` and formatting check clean.
  - Core & Renderer suites: `test:core` 2,033 passed (0 failed), `test:renderer` 93/93 passed.
  - Desktop node test suite (`test:git`): 290/290 passed (including `rustWorkflowBridge.test.ts`, `rustTrackerBridge.test.ts`, `rustAiBridge.test.ts`, `rustDeploymentBridge.test.ts`, `rustProfileBridge.test.ts`, `rustTerminalBridge.test.ts`, `rustChannelParity.test.ts`, `sharedSettingsBackend.test.ts`, and `workflowPolicyReadParity.test.ts`).
  - Dual-mode E2E gate (`runRustDualModeE2e.cjs`): 29/29 passed in TypeScript mode (`none`) and 29/29 passed in Rust mode (`default`).
  - Terminal & Profile desktop E2E: 12/12 passed (`terminal.spec.ts`, `rustProfiles.spec.ts`).
  - Packaged candidate check (`verifyRustHostCandidate.cjs`): passed.
- Scopes 1 (Remote CI), 7 (Physical iPhone/Flutter), and 9 (Dirty worktree cleanup) remain explicitly deferred per user direction.

## Tests to keep passing

- `main/src/main/adapters/jsonKeyValueStore.test.ts` — persistence ordering and failure recovery for workflow/project stores.
- `main/src/main/workflowPolicyReadParity.test.ts` — actual TypeScript/Rust read parity, including pending and failed writes.
- `main/src/main/rustChannelParity.test.ts` — complete exercised coverage of delegated channel contracts and mutations.
- `main/e2e/{folder,folderMulti,editIssue,newIssue}.spec.ts` — folder compatibility and safe writes to temporary copies only.
- `main/e2e/{workflowPolicy,scheduledProviderHandover,terminal}.spec.ts` — affected live behavior as each domain is wired.
- `main/scripts/runRustDualModeE2e.cjs` — explicit runtime diagnostics and selected desktop checks in both backend modes.
- Rust workspace and desktop/mobile suites — preserve current baseline and keep passed, failed, skipped and unrun results distinct.

## Keeping this register current

When creating a branch or worktree, add its branch name, absolute path, purpose, owner or task, starting point and current status. Update the entry at handover and after integration; record uncommitted or untracked work and any remaining action. When retiring one, verify its unique commits and working-tree changes first, preserve needed work, then record its removal or remove its entry. Never force-delete unmerged history without explicit approval.

For a fresh inventory, run `git worktree list --porcelain`, `git branch -vv`, and `git status --short` in each worktree. Compare each branch against the intended integration branch with `git rev-list --left-right --count main...<branch>` and inspect any unique commits and diffs. A clean Git status does not establish that ignored files are disposable.
