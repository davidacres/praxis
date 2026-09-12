---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-153
title: "Add deployment transitions and policy"
status: Done
story: FX-BE-058
updated: 2026-09-09
dependencies: [FX-BE-057]
---

# TASK-153: Add deployment transitions and policy

**Priority:** High
**Created:** 2026-09-07

## Goal

Define prepared, awaiting-approval, queued, deploying, verifying, succeeded, failed, cancelled, unknown and rollback transitions; approval binds profile version, digest and environment.

## Implementation entry points

packages/core/src/workflows/workflowTypes.ts; workflowRun.ts; workflowRecovery.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-057
## Acceptance criteria

- Changing artifact or target invalidates approval; only verified health yields succeeded; concurrent deployment to a locked target is queued or refused explicitly.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:** `packages/core/src/projects/deploymentRunState.ts` (new), deliberately built in
`workflows/workflowRun.ts`'s exact architecture (the task's own entry points name it as a reference)
rather than a new idiom: a run is a reduced value, every transition a pure `(run, command) => run`
step appending to an event log, replay-safe by construction.

- `DeploymentRunStatus`: `prepared | awaiting-approval | queued | deploying | verifying | succeeded |
  failed | cancelled | unknown | rolling-back | rolled-back` — the task's own listed set, plus
  `rolling-back` (an explicit in-progress status between `succeeded`/`failed` and `rolled-back`;
  jumping straight to a terminal `rolled-back` with no in-between step would be the same shortcut the
  design refuses for `succeeded`, so it gets the same treatment).
- **"Only verified health yields succeeded" is structural, not a runtime check**: the command
  vocabulary itself has no path from any status but `verifying` to `succeeded` — `health-verified`
  is a no-op from every other status. Tested directly: sending it from `prepared` and from
  `deploying` (skipping `verifying`) both leave the run unchanged.
- **"Changing artifact or target invalidates approval"**: `DeploymentApproval` binds
  `profileVersion`, `artifactId`+`artifactDigest`, and `environment`. Added `DeploymentProfile.version`
  (extending TASK-150/151's schema) — a plain integer bumped by whoever writes an edit, deliberately
  not inferred from `updatedAt` (a timestamp comparison is fragile for something an approval's
  validity actually depends on). `isApprovalValid` re-checks all four fields; since editing the
  `target` bumps the profile's own `version`, a target change is caught by the version check alone
  with no separate target-specific comparison needed — proven with two tests (a version bump
  invalidates, a different published artifact invalidates). The reducer's own `invalidate-approval`
  command drops the run back to `awaiting-approval` and clears the stale approval.
- **"Concurrent deployment to a locked target is queued or refused explicitly"**:
  `DeploymentTargetLockRegistry` (a separate, small class — the run reducer itself has no notion of
  "target," only `targetLockKey(TargetRef)` gives two profiles naming the same physical destination
  the same identity). `tryAcquire(key, runId, policy)` takes an explicit `'queue'` (default) or
  `'refuse'` policy per attempt; `release` hands the lock to the next queued run and reports its id
  so a caller can advance it; `removeFromQueue` lets a cancelled-while-waiting run drop out without
  disturbing the current holder. 8 tests cover acquire/queue/refuse/release-to-next/
  release-clears-when-empty/cross-target-independence/non-holder-can't-steal/self-reacquire/
  queue-removal.
- **"Crash after dispatch but before acknowledgement produces unknown ... never an automatic second
  deployment"**: `mark-unknown` is accepted only from `deploying`/`verifying` (nothing before that is
  ambiguous enough to need it) and is itself idempotent once reached. Critically, there is no command
  in the vocabulary that re-issues `deploy-started` from `unknown` — reconciliation (detecting the
  crash and calling `mark-unknown` in the first place) is TASK-154's job, named explicitly as such in
  this module's own doc comment; this task defines the status it reduces to and refuses to auto-advance
  out of, not the detection.
- **"Completed steps are not replayed"**: proven directly — re-sending `request-approval` after it
  was already absorbed produces the identical run with no new event appended, and a fully settled run
  (`succeeded`) is completely `deepEqual`-unchanged by a later `cancel`.
- **Caught during implementation, by the test suite itself:** the first draft put `succeeded`/`failed`
  in a single `SETTLED_STATUSES` set used as a blanket top-of-reducer guard
  (`if (isDeploymentRunSettled(run)) return run;`). That guard silently swallowed `start-rollback`
  from a `succeeded` or `failed` run — rollback tests failed immediately, showing the run stuck at
  `succeeded`/`failed` instead of moving to `rolling-back`. Fixed by recognizing two different
  concepts were conflated: `isDeploymentRunSettled` (a public query — "is this deploy attempt done,"
  true for `succeeded`/`failed`/`cancelled`/`rolled-back`, used by a caller/UI) is not the same as
  "accepts no further commands at all" (true only for `cancelled`/`rolled-back` — rollback still acts
  on a settled `succeeded`/`failed` run). The reducer now only blanket-refuses those two truly-final
  statuses; every other command already carried its own precise source-status check, verified by
  auditing each one before removing the blanket guard.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root), one
clean run — **735/735 passing** (25 new in `deploymentRunState.test.ts` + 1 new `version` validation
test in `deploymentProfile.test.ts`; existing `deploymentProfile.test.ts`/`deploymentProfileStore.test.ts`
fixtures updated to include the new required `version` field, no behavior change beyond that).
`npx tsc --noEmit -p .` in `apps/praxis-desktop/main` and `npm run check-types` in
`apps/praxis-desktop/renderer` — both clean.

**Remaining limitations:** No persistence (a `DeploymentRun` is an in-memory reduced value with no
store yet — that's TASK-154's "persist side effects and reconcile," which also owns actually
*detecting* a crash and issuing `mark-unknown`, and actually driving the reducer from real dispatch/
health-check events). No IPC or UI — that's TASK-155's "integrate workflow designer and monitor."
`DeploymentTargetLockRegistry` is in-memory only and per-process; nothing here persists lock state
across a restart (a crash while holding a lock currently has no automatic release — that composes
with TASK-154's reconciliation, which would need to release stale locks for runs it marks `unknown`
or settles during recovery). Nothing here is Electron-dependent, so — like TASK-150/151/152 — there
is nothing left that this sandbox's Electron block leaves unproven; marked `complete` on that basis.

## Description


## Comments


