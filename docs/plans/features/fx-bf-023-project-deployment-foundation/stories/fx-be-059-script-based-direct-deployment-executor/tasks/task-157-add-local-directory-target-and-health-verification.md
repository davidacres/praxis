---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-157
title: "Add local directory target and health verification"
status: complete
story: FX-BE-059
updated: 2026-09-09
dependencies: [TASK-156]
---

# TASK-157: Add local directory target and health verification

**Priority:** High
**Created:** 2026-09-07

## Goal

Implement a template for a persistent local web root with staging, backup/restore and configured post-install health check; distinguish application content from mutable data.

## Implementation entry points

main/src/main; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-156
## Acceptance criteria

- A fixture web root updates from one immutable artifact, excludes configured user data, fails on bad health and can restore the previous version.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- `packages/core/src/deployments/directoryTarget.ts` (new) — the
  `directory` target's full lifecycle for a persistent local web root:
  - **"Distinguish application content from mutable data"** is structural,
    not heuristic: every file `PublishManifest.files` names is application
    content, owned by the deploy; every path matching a caller-configured
    `excludePaths` entry is mutable data and is never read, copied, or
    deleted by this module. There is no third category and no inference —
    `isExcluded` is a simple prefix match against the exact configured list.
  - **`applyDirectoryDeployment`** — stages the new artifact's files into a
    scratch directory first (so a source-side read failure never touches
    the live target at all), backs up the target's current non-excluded
    content, removes that content, then copies the staged files in. Refuses
    outright — before touching the target — when an exclude path is not a
    safe relative path (`isValidExcludePath`: no absolute path, no `..`
    traversal, every segment passing the same `isSafeSegment` charset
    `workflows/workflowEvidence.ts` already uses for evidence paths), or
    when `validatePublishedArtifact` (TASK-152) finds the artifact on disk
    no longer matches the manifest it's supposed to be — an artifact is
    "immutable" as a design invariant, and this is where that invariant is
    actually checked before it's trusted.
  - **`restoreDirectoryBackup`** — puts a backup's content back, still
    honouring the same exclude list throughout.
  - **`verifyDirectoryHealth`** — runs a `RunReadinessProbe` (the same type
    `projects/runProfile.ts` and `DeploymentProfile.healthCheck` already
    use) against a given host:port, via the newly-shared `checkHttpOk`/
    `checkTcpOpen`. A `log-line` probe is refused outright rather than
    silently treated as passing — a directory target has no process of its
    own with a log stream Praxis controls, so pretending that check ran
    would be worse than admitting it can't.
  - **`deployDirectoryWithHealthCheck`** — the acceptance criterion's
    "fails on bad health and can restore the previous version" as one
    integrated call: applies the deploy, runs the configured health check
    if any, and on failure automatically restores the backup the same call
    just took, reporting `restored: true/false` — no caller can apply
    without a restore path, and no caller can check without ever having
    applied.
- **Reuse, not reinvention**, twice over in this task:
  - Extracted the readiness-probe checks (`checkTcp`/`checkHttp`, private
    to `runServiceManager.ts`) into a new shared
    `packages/core/src/host/networkProbe.ts` (`checkTcpOpen`/`checkHttpOk`,
    host now a parameter rather than hard-coded `127.0.0.1`), the same
    pattern TASK-156 used for `killProcessTree`. `runServiceManager.ts` now
    delegates to the shared functions with its original `127.0.0.1`
    default preserved; its own 32 tests pass unchanged.
  - Exported `publishManifest.ts`'s private recursive file-listing walk as
    `listFilesRecursive`, so this module's own "what does the target
    currently hold" scan is the identical implementation
    `buildPublishManifest`/`validatePublishedArtifact` already use, not a
    second copy of the same directory walk. `publishManifest.test.ts`'s 11
    tests pass unchanged, confirming the rename/export is behavior-preserving.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. Targeted
`node --test` on `directoryTarget.test.js` (17/17),
`runServiceManager.test.js` + `publishManifest.test.js` together (32/32,
confirming both extractions changed nothing observable). `npm run
test:core` from the repo root (confirmed no stray background test/tsc
processes first) — **813/813 passing** (up from 796; 17 new). `npx tsc
--noEmit -p .` in `apps/praxis-desktop/main` — clean (unaffected; no
main-process file touched). `npm run check-types` in
`apps/praxis-desktop/renderer` — clean (unaffected).

**Acceptance criterion, verified directly, not assumed:** "A fixture web
root updates from one immutable artifact, excludes configured user data,
fails on bad health and can restore the previous version" — each clause has
its own passing test: whole-tree update from an artifact
(`applyDirectoryDeployment` tests), stale application files removed on the
next deploy, an excluded `uploads/` file surviving a deploy untouched and
never appearing in `filesWritten`, a tampered artifact refused before the
target is touched at all, and the integrated health-check-fails-then-
restores flow putting the exact previous byte content back.

**Remaining limitations:**

- No IPC/UI/main-process wiring, and no `DeploymentRun` integration
  (minting an `operationId`, driving `applyDeploymentRunCommand`'s
  `start-deploying`/`start-verifying`/`health-verified`/`health-failed`/
  `start-rollback` sequence around a real call to
  `deployDirectoryWithHealthCheck`) — that composition is TASK-158's scope
  ("Expose direct deployment actions"), not this task's. This module is a
  pure filesystem/network primitive a future caller drives.
- `backupDir`/`stagingDir` are caller-supplied paths with no retention
  policy applied here — `DeploymentRollbackPolicy.retainCount`
  (`deploymentProfile.ts`, TASK-150) is not read or enforced by this
  module; a caller choosing where backups live and how many to keep is
  future wiring, consistent with this module knowing nothing about
  `DeploymentProfile` at all (it only takes a bare `DirectoryTargetRef`).
- No IIS-specific behavior — `IisTargetRef` (`deploymentProfile.ts`)
  remains schema-valid but unimplemented, which is FX-BF-025's scope and,
  since IIS is Windows-only, likely unverifiable in this sandbox when
  reached.
- Nothing here is Electron-dependent, so — like TASK-156 — there is
  nothing this sandbox's inability to launch Electron leaves unproven;
  marked `complete` on that basis.

## Description


## Comments


