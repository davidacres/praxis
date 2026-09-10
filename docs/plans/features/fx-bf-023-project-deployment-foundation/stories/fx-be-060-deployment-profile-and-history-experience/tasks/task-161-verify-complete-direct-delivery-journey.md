---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-161
title: "Verify complete direct delivery journey"
status: in-progress
story: FX-BE-060
updated: 2026-09-09
dependencies: [TASK-160]
---

# TASK-161: Verify complete direct delivery journey

**Priority:** High
**Created:** 2026-09-07

## Goal

Exercise build/publish, prepared artifact review, deployment, failed health and rollback; update docs and parity matrix with implemented versus unavailable adapters.

## Implementation entry points

renderer/src/deployments (new); renderer/src/app; docs/user-guide.md. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-160
## Acceptance criteria

- Mock/scripted journeys run without production credentials; inspect light/dark and narrow viewport captures, keyboard flow and failure states.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- **`packages/core/src/deployments/directDeliveryJourney.test.ts`** (new) —
  one continuous, scripted narrative test exercising every named step in
  order, against real local fixtures (temp directories, a real
  `http.createServer` standing in for a health-check target), with no
  network access and no production credentials anywhere in the flow:
  1. **Build** — files written to a temp directory (a "build" is nothing
     more than files landing somewhere; the feature has no build step of
     its own).
  2. **Publish** — `createPublishedArtifact` hashes the build into an
     immutable, digest-identified artifact.
  3. **Prepared artifact review** — `validateDeploymentProfile` (shape),
     `preflightDeploymentCapabilities` (capability), and
     `evaluateCredentialBindings` against a profile that names a credential
     no local machine has bound, asserting it reports `bound: false` rather
     than hiding or faking a pass — "profile editor supports missing
     credentials" (TASK-159) proven as part of the full journey, not in
     isolation.
  4. **Prepare + approve** the v1 build.
  5. **Deploy v1** with a real, passing health check — this is the
     "previous version" step 7's rollback later restores.
  6. **Build, publish, prepare, approve, and deploy v2** with a health
     check pointed at a port nothing listens on — settles `failed`; the
     bad version stays applied (no auto-restore), matching TASK-158's own
     deliberate design.
  7. **Explicit rollback** — restores v1's content, verified by reading
     the file back; asserts the two runs share nothing but the fact that
     they targeted the same profile (each has its own digest, its own
     approval, its own outcome: `succeeded`, `failed`, `rolled-back` — all
     three cleanly distinguishable, never conflated).
  - Found and fixed a **real bug** while writing this test — the first
    one in this task that actually round-trips a profile through
    `validateDeploymentProfile` before deploying it: `runDirectDeployment`
    and `rollbackDirectDeployment` (`directDeploymentOrchestrator.ts`, both
    from TASK-158) passed a `directory` target's `path` straight to
    `applyDirectoryDeployment`/`restoreDirectoryBackup` with no resolution
    against `projectFolder`, even though `validateDeploymentProfile`
    requires a directory target's `path` to be **repo-relative**, not
    absolute (`isPortableFolderPath`, the same rule already enforced for a
    `local-process` target's `cwd`, which *was* correctly resolved).
    Every prior orchestrator test constructed a profile with an absolute
    temp-dir path directly and never validated it, so this gap was never
    exercised until a genuinely realistic, validated profile went through
    the full path. Fixed by resolving `target.path` with the existing
    `resolvePortableFolderPath` (`workspaces/workspacePaths.ts`) — reused,
    not reimplemented, the same helper that already passes an
    already-absolute path through unchanged, so no existing test needed
    its fixture paths rewritten. Applied identically to both
    `runDirectDeployment`'s deploy dispatch and `rollbackDirectDeployment`,
    and to the `local-process` `cwd` resolution for consistency (same
    behavior, one shared helper instead of two hand-rolled `path.join`
    calls). `RollbackDirectDeploymentInput` gained a required
    `projectFolder` field to make this resolution possible; every existing
    call site (7 in `directDeploymentOrchestrator.test.ts`, main process's
    `deploymentControlIpc.ts`) was updated.
- **`docs/desktop-feature-parity.md`** — six new rows under "Developer
  workflow": deployment profiles, the direct-process executor for each
  target kind, promotion, and the two explicitly-unimplemented adapters
  (GitHub Actions/GitLab CI executors, IIS target) — "implemented versus
  unavailable adapters," this task's own words, made literal. Audit date
  bumped to match.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. Targeted `node
--test` on `directDeliveryJourney.test.js` (1/1), plus
`directDeploymentOrchestrator.test.js`/`directoryTarget.test.js`/
`directProcessExecutor.test.js` together (46/46, confirming the path-
resolution fix broke nothing). `npm run test:core` from the repo root
(confirmed no stray background test/tsc processes first) — **835/835
passing** (up from 834). `npx tsc --noEmit -p .` in
`apps/praxis-desktop/main` — clean (after fixing the one real call site the
`RollbackDirectDeploymentInput` change touched). `npm run check-types` in
`apps/praxis-desktop/renderer` — clean (renderer untouched by this task;
the check confirms nothing regressed).

**Acceptance criterion, verified directly:** "Mock/scripted journeys run
without production credentials" — the journey test is exactly that: every
fixture is local (temp directories, an ephemeral local HTTP server), the
one credential the profile names is deliberately left unbound to prove the
review step surfaces that honestly, and nothing in the test touches a
network resource, a real secret, or any external service.

**Remaining limitations:**

- "Inspect light/dark and narrow viewport captures, keyboard flow and
  failure states" was not possible in this sandbox — no `node-pty` native
  binding, and the egress policy blocks the rebuild that would fix it.
  Everything UI-shaped in this feature (TASK-159/160's renderer pages)
  compiles clean end-to-end but has never been visually exercised in a
  running app. This is the one clause of this task's acceptance criterion
  genuinely left undone, not merely under-evidenced — marked `in-progress`
  specifically because of it, and every task in FX-BE-059/060 that touched
  the renderer carries the identical caveat.
- The journey test exercises the **directory** target end to end (build,
  publish, deploy, fail, rollback); it does not also walk a full
  `local-process` target through the same failure/rollback shape, since
  `local-process` has no rollback mechanism at all (an intentional
  TASK-157/158 scope boundary, exercised separately by
  `directDeploymentOrchestrator.test.ts`'s own "rollback on a local-process
  target is refused" test) — a second full directory-shaped journey for a
  different target kind would not have proven anything new.
- This journey does not exercise the renderer's own publish/promote UI
  (`DeploymentsPage.tsx`) — it calls the same core orchestrator functions
  the IPC handlers wrap, directly, which is the whole of what is testable
  without Electron. The IPC and UI layer's own correctness rests on the
  type-checked contract chain (core → main → preload → renderer) verified
  in TASK-158/159/160, not on this journey test.

## Description


## Comments


