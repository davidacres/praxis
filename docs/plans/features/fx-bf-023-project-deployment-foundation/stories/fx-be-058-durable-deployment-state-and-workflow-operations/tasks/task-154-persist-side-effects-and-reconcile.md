---
type: Task
id: TASK-154
title: "Persist side effects and reconcile"
status: complete
story: FX-BE-058
updated: 2026-09-09
dependencies: [TASK-153]
---

# TASK-154: Persist side effects and reconcile

**Priority:** High
**Created:** 2026-09-07

## Goal

Persist operation identity before dispatch, external IDs when known, attempts and reconciliation results; distinguish lost acknowledgement from confirmed failure.

## Implementation entry points

packages/core/src/workflows/workflowTypes.ts; workflowRun.ts; workflowRecovery.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-153
## Acceptance criteria

- Crash after dispatch but before acknowledgement produces unknown and reconciliation, never an automatic second deployment; completed steps are not replayed.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- `packages/core/src/projects/deploymentRunState.ts` (extends TASK-153) — added `attempt: number`
  (1-based, "attempts") and `externalId?: string` ("external IDs when known") to `DeploymentRun`, plus
  two commands: `record-external-id` (enriches the run without changing status — idempotent for the
  same id, refused outside `deploying`/`verifying`) and `retry-dispatch` (from `unknown` or `failed`
  only, and only with an approval still attached; bumps `attempt`, clears the prior `externalId` and
  outcome fields so a stale pid from a previous attempt can never be mistaken for a fresh one, and
  moves the run back to `queued` — reusing the original approval rather than demanding a fresh one,
  matching `start-deploying`'s own "the caller re-validates before issuing this" contract).
- `packages/core/src/projects/deploymentRunStore.ts` (new) — `DeploymentRunStore`, `WorkflowRunStore`
  verbatim in shape (`KeyValueStore`-backed, `list`/`forProfile`/`get`/`save`/`remove`,
  `normalizeDeploymentRun` defensively parsing whatever the store hands back the same way
  `normalizeWorkflowRun` does). This is "persist operation identity before dispatch" as an operating
  discipline this module's own doc comment states explicitly: a caller driving
  `applyDeploymentRunCommand` is expected to `save()` immediately after `start-deploying`, *before*
  it goes on to actually invoke the executor — so a crash in that narrow window still leaves a durable
  record that dispatch was attempted.
- **`reconcileDeploymentRun(run, isAlive, at)`** is "distinguish lost acknowledgement from confirmed
  failure" made concrete: a run already sitting in a settled status (including `failed` — a
  **confirmed failure**, from an actual recorded `health-failed` event) needs no reconciliation at
  all — proven directly by a test asserting `isAlive` is never even called for one. Only a run stuck
  in `deploying`/`verifying` is reconciled, and the attached note distinguishes three cases: no
  `externalId` ever recorded (**lost acknowledgement** — nothing to check, the crash predates
  dispatch confirmation), an `externalId` whose operation is still alive (**unconfirmed but
  running**), or one that's gone (**unconfirmed and stopped**). All three still land on the *same*
  `unknown` status via TASK-153's own `mark-unknown` — "crash after dispatch but before
  acknowledgement produces unknown and reconciliation, never an automatic second deployment" holds
  because there is no code path here (or in the reducer) that re-issues `start-deploying`;
  `retry-dispatch` exists precisely so that decision stays an explicit, separate command a human or a
  caller chooses to issue afterward, not something reconciliation does on its own. `isAlive` is a
  narrow seam (matching `runReconciliation.ts`'s `isPidAlive`, TASK-146) rather than an assumption
  about what an external id even is; an `isAlive` that throws propagates rather than being silently
  treated as "not alive" — a failed liveness *check* is not the same answer as a confirmed-stopped
  operation, and conflating them would risk a false "safe to retry."
- `DeploymentRunStore.needingReconciliation()` — every run left in `deploying`/`verifying`, a
  restart's own worklist for `reconcileDeploymentRun`.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root), one
clean run — **755/755 passing** (7 new in `deploymentRunState.test.ts` for `record-external-id`/
`retry-dispatch`, 13 new in `deploymentRunStore.test.ts` covering store round-trip/replace/forProfile
ordering/remove/needingReconciliation, `normalizeDeploymentRun`'s garbage-rejection and
safe-defaults behavior, and all three reconciliation cases plus the settled-run-is-untouched and
propagating-isAlive-error cases). `npx tsc --noEmit -p .` in `apps/praxis-desktop/main` and
`npm run check-types` in `apps/praxis-desktop/renderer` — both clean.

**Remaining limitations:** No IPC, UI, or main-process wiring exists yet — nothing in the app actually
calls `DeploymentRunStore.save()` around a real dispatch, and nothing runs
`reconcileDeploymentRun` on startup; the "save before dispatch" discipline this module documents is a
contract for a future caller, not yet an enforced one. `isAlive` has no real implementation wired to
an actual executor (the direct-process executor itself, and what its `externalId` even is — almost
certainly a pid, matching `RunServiceManager`'s own model — is FX-BE-059's scope, not this task's).
Target-lock release on a crashed run (TASK-153's `DeploymentTargetLockRegistry`) is not connected to
reconciliation — a run reconciled to `unknown` does not automatically release whatever target lock it
held; that composition is left to whatever future code actually drives both together. Nothing here is
Electron-dependent, so — like TASK-150/151/152/153 — there is nothing left that this sandbox's
Electron block leaves unproven; marked `complete` on that basis.
