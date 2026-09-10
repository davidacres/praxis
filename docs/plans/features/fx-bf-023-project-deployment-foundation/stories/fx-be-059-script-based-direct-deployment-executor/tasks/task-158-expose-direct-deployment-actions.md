---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-158
title: "Expose direct deployment actions"
status: in-progress
story: FX-BE-059
updated: 2026-09-09
dependencies: [TASK-157]
---

# TASK-158: Expose direct deployment actions

**Priority:** High
**Created:** 2026-09-07

## Goal

Provide prepare, approve, deploy, health results and explicit rollback actions; unsupported rollback explains the reason and leaves evidence.

## Implementation entry points

main/src/main; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-157
## Acceptance criteria

- A folder-backed project deploys to a temporary local server without GitHub; repeated click and reconnect cannot duplicate execution.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- `packages/core/src/deployments/directDeploymentOrchestrator.ts` (new) —
  the five named actions as pure orchestration over what TASK-153/154/156/157
  already built; nothing here reimplements the `DeploymentRun` state
  machine's own transition guards.
  - **`prepareDirectDeployment`** — creates and persists a fresh run.
  - **`approveDirectDeployment`** — requests then grants approval,
    re-checking `isApprovalValid` (TASK-153) before persisting; refuses with
    a reason when the profile version or artifact digest no longer match.
  - **`runDirectDeployment`** ("deploy") — dispatches to the profile's
    target: `directory` via `applyDirectoryDeployment` (TASK-157),
    `local-process` via `runDirectProcessDeployment` (TASK-156, artifact
    path forwarded as the `ARTIFACT_PATH` typed input). Either path lands
    on `verifying`, then evaluates `profile.healthCheck` if configured
    (reusing `verifyDirectoryHealth`, which despite its name is a plain
    probe-against-host:port check with nothing directory-specific in its
    logic) before settling `succeeded`/`failed`. Deliberately does **not**
    auto-restore on a failed health check — rollback stays a separate,
    explicit action, matching `applyDeploymentRunCommand`'s own
    `start-rollback` guard (`succeeded`/`failed` only, never invoked by the
    deploy path itself).
  - **`deploymentHealthResult`** ("health results") — a pure, read-only
    query over a run's own event log; never mutates the run or touches the
    store.
  - **`rollbackDirectDeployment`** ("explicit rollback") — restores a
    `directory` target's backup via `restoreDirectoryBackup` (TASK-157).
    For any other target kind (`local-process` has no backup/restore
    mechanism at all — that was never built, on purpose, in TASK-157) the
    rollback is refused, but `start-rollback` still fires before the
    refusal, so the run's own event log carries both `rollback-started` and
    `rollback-failed` with the reason — **"unsupported rollback explains
    the reason and leaves evidence"** verified directly by a test asserting
    both events are present, not merely that the call returned false.
  - **Repeated click and reconnect cannot duplicate execution** — two
    stacked guarantees, each proven by its own test:
    `DeploymentTargetLockRegistry.tryAcquire` (TASK-153) is a synchronous,
    no-`await`-before-return check, so two concurrent `runDirectDeployment`
    calls for the *same* run race safely — the second sees
    `'already-held-by-self'` and is refused before touching the executor,
    proven by a test spawning two calls with `Promise.all` and asserting a
    side-effect file was written exactly once, not twice. Independently,
    `applyDeploymentRunCommand('start-deploying')`'s own guard (`'queued'`
    only) refuses a *stale* re-send against an already-settled run — the
    reconnect case — proven by a test that deploys once, then re-sends
    "deploy" against the now-`succeeded` run and asserts the script did not
    run again.
- **Main process** (`apps/praxis-desktop/main/src/main`):
  - `deploymentManagerInstance.ts` (new) — singleton `DeploymentRunStore`
    (`deploymentRuns.json` under `userData`, the same `JsonKeyValueStore`
    convention `workflowStoreInstance.ts` uses for `workflows.json`) and
    `DeploymentTargetLockRegistry` (in-memory, process-lifetime).
  - `deploymentControlIpc.ts` (new) — `deployments:prepare/approve/deploy/
    getRun/listRuns/health/rollback`, each a thin pass-through to the core
    orchestrator; `deploy`/`rollback` resolve a `local-process` target's
    repo-relative `cwd` against the project's workspace folder, the same
    `projectFolder()` helper pattern `runControlIpc.ts` already uses.
    Registered in `main/src/main/index.ts` alongside the existing Run IPC
    registrations.
  - `host/ipcContracts.ts` gained `DeploymentsIpc` (mirroring `RunsIpc`'s
    shape) and `PraxisIpc.deployments`; `preload/index.ts` exposes
    `window.praxis.deployments.*` wired to the new channels — the standard
    core contract → main handler → preload exposure chain every other IPC
    surface in this app follows.
  - **Deliberately not built**: no profile-CRUD IPC (`deployments:prepare`
    etc. take a `DeploymentProfile`/`PublishedArtifact` as plain arguments,
    not a stored-profile id to look up) and no artifact-publish IPC
    wrapping `createPublishedArtifact` — picking a profile and publishing
    an artifact is FX-BE-060's UI concern ("Build profile selection and
    review"), and TASK-151/152 never built profile/artifact IPC either.
    This mirrors TASK-155's own deliberate scope line (a plain
    `deploymentProfileId` text field in the workflow designer, not a live
    picker) rather than reaching into a different story's UI work.

**Acceptance criterion, verified directly:** "A folder-backed project
deploys to a temporary local server without GitHub" — a test prepares,
approves, and deploys a `directory` target pointed at a real temp
directory, with a real temp `http.createServer` standing in for "a
temporary local server" as the post-install health check target; the
profile's executor is `direct-process` throughout, with no CI/GitHub
executor anywhere in the path. "Repeated click and reconnect cannot
duplicate execution" — both proven with real concurrent/sequential calls
and a real side-effect counter file, not just state-machine assertions.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. Targeted
`node --test` on `directDeploymentOrchestrator.test.js` — 16/16. `npm run
test:core` from the repo root (confirmed no stray background test/tsc
processes first) — **829/829 passing** (up from 813; 16 new). `npx tsc
--noEmit -p .` in `apps/praxis-desktop/main` — clean (this is the first
task in this feature with real main-process changes to check: the new
`deploymentManagerInstance.ts`/`deploymentControlIpc.ts`, the
`index.ts`/`preload/index.ts` wiring). `npm run check-types` in
`apps/praxis-desktop/renderer` — clean (renderer source untouched this
task; the check confirms nothing regressed).

**Remaining limitations:**

- No renderer UI at all — `window.praxis.deployments.*` exists and
  compiles clean, but nothing in the app calls it yet. Building the actual
  deploy screen (profile picker, artifact publish trigger, run history,
  approve/deploy/rollback buttons) is FX-BE-060's three tasks (TASK-159/
  160/161), not this one's.
- No Electron capture/verification was possible in this sandbox (no
  `node-pty` native binding; rebuild blocked by egress policy) — the IPC
  wiring compiles end-to-end but was never exercised against a running
  app, a real `BrowserWindow`, or `contextBridge`. Marked `in-progress`
  specifically for this reason, consistent with every other IPC/UI task in
  this feature.
- `DeploymentTargetLockRegistry`'s `'queue'` policy exists
  (`tryAcquire(key, runId, 'queue')`) but `runDirectDeployment` always
  passes `'refuse'` — a second run targeting the same destination is
  rejected outright rather than queued and auto-dispatched once the first
  releases. Wiring the queue-drain (`release()`'s returned `nextRunId`
  triggering that run's own dispatch) is a deliberate scope narrowing, not
  an oversight: this task's own acceptance criterion is about *not
  duplicating* execution, which "refuse" already guarantees; auto-draining
  a queue is additional behavior no acceptance criterion here asked for.
- Health-check-on-failure never auto-restores (by design, see above); a
  caller must explicitly invoke `rollback` after seeing a `failed` run.
  This is a deliberate reading of the state machine's own shape, not an
  oversight — documented above and worth flagging again here since it is
  the one place this task's design diverges from TASK-157's own
  `deployDirectoryWithHealthCheck` (which does auto-restore) rather than
  simply calling it.

## Description


## Comments


