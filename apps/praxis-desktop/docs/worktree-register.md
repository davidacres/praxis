# Local branch and worktree register

Snapshot: 2026-11-10. This is a manual inventory of this machine, not a live Git view. Refresh it whenever a branch or worktree is created, handed over, merged or removed. Paths and status can differ on another machine.

## Data compatibility and evidence correction — 2026-11-10

This correction supersedes the full-parity and real-Tauri-E2E claims below.
The previous audit implemented `parityVerified = registered`; it proved no behavioral
parity. It now reports 407 registered, 0 missing, 0 independently verified channels.
The desktop test runner is accurately labeled as headless checks.

Existing-data repair: legacy session index/transcript readers, activation-preserving
chat storage, installed theme discovery, renderer response shapes and saved zoom.
Read-only conversation/appearance paths no longer load/heal project metadata or
contend on its exclusive writer lock. Tests cover catalog corruption and an active
writer lock without hiding or rewriting saved conversations.

Fresh evidence: 39 native tests passed, 1 opt-in copied-profile check ignored by the
default suite and run separately; 95 renderer tests passed; renderer production
build/typecheck/bridge checks passed. The copied profile returns 469 session records,
3 hydrated recent transcripts, 26 complete team chats and the saved GitHub Dark look.
Native visual verification opened a complete saved session transcript, reloaded it,
and opened the existing Praxis Mobile team chat with saved messages and 120% zoom.
25 chats are archived in the source data; those flags were retained.

Screenshots and detailed limits are preserved under `.praxis/session-artifacts/` in
`tauri-data-compatibility-verification.md`. Some older source transcripts are already
partial; this pass does not establish recovery of every historical message. Live
execution/runtime parity and platform/release gates remain open. The installed
Electron app was not replaced or closed by this work.

| Branch | Worktree | Purpose | Status and outstanding work |
| --- | --- | --- | --- |
| `main` | `/Users/daveacres/dev/tools/praxis` | Primary checkout and integration branch for the Rust migration. | Observed HEAD `fdb7d0e7`. Legacy Electron main process (`apps/praxis-desktop/main`) and dependencies (`electron`, `electron-builder`, `node-pty`) deleted and retired per user approval. Tauri desktop shell (`praxis-desktop`) is the sole application shell. All 407 desktop channels registered. The former full-parity claim was invalid: registration was counted as verification. Data compatibility fixes and targeted native-window verification are in progress; full parity and release gates remain open. Untracked `apps/praxis-desktop/.agents/` remains untouched. |

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
- Tauri desktop shell migration (TASK-527 / FX-BE-199):
  - In-process application services in `src-tauri/src/application/` fully implemented and wired across all domain clusters: workspaces, projects, connections, boards, issues, boardPrefs, logBus, activity, notes, artifacts, scheduledRuns, workflows, system/pairing, marketplace, deployments, runs, taskDesigner, webviews/browser/preview/detachedChat, gadgets, aiUsage, assistant, agentRuntime, and ai.
  - Registered channel coverage reached **407 of 407 desktop channels (100% complete, 0 missing)**.
  - Implemented and verified isolated child webviews with the loopback guard proxy, DNS pre-resolution checking, preview access origin registry, and diagnostics recording in `src-tauri/src/webviews/` (`guard_policy.rs`, `preview_access.rs`, `diagnostics.rs`, `guard_proxy.rs`) with capabilities isolated (`main.json` vs `child-browsers.json`).
  - Correction: the former 407/407 parity result was derived solely from registration. The audit now reports `verifiedCount: 0`, `parityVerified: false`; independent channel receipts and full UI journeys remain open.
  - `scripts/test-tauri-e2e.cjs` runs headless registration/storage checks and Rust/renderer unit tests. It does not drive a webview and does not prove E2E parity. Fresh data-compatibility evidence appears in the correction below.
  - All 34 `praxis-desktop` native unit and integration tests pass.
- Local verification results:
  - Rust workspace: 1,163+ tests passed across all crates, Clippy with `-D warnings` and formatting check clean.
  - Core & Renderer suites: `test:core` 2,033 passed (0 failed), `test:renderer` 95/95 passed.
  - Desktop node test suite (`test:git`): 290/290 passed (including `rustWorkflowBridge.test.ts`, `rustTrackerBridge.test.ts`, `rustAiBridge.test.ts`, `rustDeploymentBridge.test.ts`, `rustProfileBridge.test.ts`, `rustTerminalBridge.test.ts`, `rustChannelParity.test.ts`, `sharedSettingsBackend.test.ts`, and `workflowPolicyReadParity.test.ts`).
  - Dual-mode E2E gate (`runRustDualModeE2e.cjs`): 29/29 passed in TypeScript mode (`none`) and 29/29 passed in Rust mode (`default`).
  - Terminal & Profile desktop E2E: 12/12 passed (`terminal.spec.ts`, `rustProfiles.spec.ts`).
  - Tauri E2E suite (`npm run test:desktop:tauri`): passed all 4 stages.
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

## Tauri shell checkpoint - 2026-11-10

User activated the shell migration. Work is uncommitted on `main`, observed HEAD
`fdb7d0e7`; no branch/worktree, remote run, installed-app replacement or publication
was created. The earlier `627f1dbe` row and 2026-11-09 results above are historical.
The pre-existing untracked `.agents/` tree remains untouched.

- Added `apps/praxis-desktop/src-tauri` to Cargo, composing `HostContext` and shared
  `HostServices` in process. The stdio binary uses the same startup composition.
- Added native window controls, menus, folder selection, safe external URLs,
  persisted geometry, explicit local-main capabilities and host event forwarding.
- Generated all 407 preload invocation mappings and 30 event channels. Tauri uses
  `@tauri-apps/api` to install `window.praxis` before importing the existing UI.
- Fresh audit: **78/407 mappings have a registered handler; 329 are missing**.
  Registration is not payload/behavior parity. The `--require-complete` gate fails
  deliberately. Mobile transport's reverse application calls fail closed until
  their Electron application adapter is replaced in Rust.
- The executable and local macOS `.app` preview bundle build. The bundle uses the
  existing Praxis artwork converted to ICNS/ICO; no distribution/signing or
  supported-platform release gate is claimed. Tauri remains opt-in and the
  installed/release Electron application remains the release path.
- Fresh checks passed: renderer production build/typecheck; 95 renderer tests;
  Rust host/shell tests (2 shell + 35 host + 5 integration = 42); Clippy for both
  changed crates with all targets/features and `-D warnings`; `cargo fmt --all
  --check`; generated-bridge drift and npm licence inventory checks; `git diff
  --check`. Linux prerequisites were added to CI configuration but not run remotely.
- Initial full Electron functional run (before entry-page fix): **753 passed, 21 failed, 14 skipped** over
  23.1 minutes. Failures include command-palette navigation/timeouts, activity
  text, gadget/preview behavior, affected-test selection, workflow cancellation,
  bypass policy and check-log behavior. Serial checks exposed a startup race from
  the shared asynchronous bootstrap: Electron reload completed before its keyboard
  handlers were ready. Electron's original entry is now restored and Tauri uses
  `tauri.html`. Two affected reload/navigation cases then passed (15.9 seconds).
  The initial serial retry was interrupted after identifying that regression;
  final focused results are recorded separately and do not make this full run green.
- Native visual verification: opened the final Tauri app at `tauri://localhost/tauri.html`,
  navigated Settings -> Themes, selected Praxis Dark, confirmed `themeId:
  praxis-dark` and `themeMode: dark` in the isolated Rust settings file, reloaded
  through the native command, confirmed the active theme persisted, then quit
  cleanly (exit 0). Rebuilt with the dedicated entry, restarted the app, verified
  the same theme from disk, captured the final build and quit again (exit 0). Screenshot retained at
  `.praxis/session-artifacts/tauri-preview-themes.jpg` (JPEG). Missing marketplace
  operations surface as explicit errors; the complete app is not verified.
- Plan parser before/after: 60 features, 195 stories, 655 child items; FX-BE-199 and
  TASK-527 both still parse with explicit types, H1 titles and In Progress status.

See [migration plan and frontend assessment](desktop-tauri-migration.md) and
[actual channel audit](tauri-contract-audit.json). Remaining work includes all
missing desktop application adapters, payload/side-effect proof, native lifecycle
and integrations, keychain/mobile ownership, protected child webviews, real Tauri
journeys, supported-platform packaging/release proof, approved legacy retirement
and the Rust UI port. Electron and TypeScript removal is not complete. Cargo
licence inventory remains a release gate; the npm inventory alone does not prove it.

### Final focused verification after entry-page fix

The original 21 failing selections expanded to 22 tests because one is parameterized.
Fresh serial result on the final renderer: **14 passed, 8 failed** (3.7 minutes).
Together with the separate 2/2 reload regressions, this verifies recovery of the
startup/navigation failures. It is not a fresh green full-suite result. The full
788-test suite was not repeated after the fix; the initial result remains above.

The 8 unresolved checks are:

- `aiCliAgentHost.spec.ts:679` - custom activity words.
- `aiThoughtGrouping.spec.ts:210` - final-reply artifact gadget.
- `workflowChangeTests.spec.ts:30` - affected QA test selection/output.
- `workflowEnvironmentPause.spec.ts:173` - audit failure/sibling cancellation.
- `workflowRun.spec.ts:293` - bypass policy notice.
- `workflowRun.spec.ts:862` - timed-out check outcome.
- `workflowRun.spec.ts:881` - retained/redacted check log.
- `workflowRun.spec.ts:919` - empty check-log state.

These remain unresolved, not classified as inherited or harmless. No snapshots were
updated. Full Rust workspace rerun, real Tauri E2E harness, Windows/Linux native
execution and signed release verification remain unrun in this session. The fresh
42 Rust tests are the host/shell targeted suites only.
