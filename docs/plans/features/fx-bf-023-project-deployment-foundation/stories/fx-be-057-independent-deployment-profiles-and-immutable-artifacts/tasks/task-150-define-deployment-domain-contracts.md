---
type: Task
id: TASK-150
title: "Define deployment domain contracts"
status: complete
story: FX-BE-057
updated: 2026-09-09
dependencies: [FX-BF-021]
---

# TASK-150: Define deployment domain contracts

**Priority:** High
**Created:** 2026-09-07

## Goal

Model DeploymentProfile, ExecutorRef, TargetRef, PublishedArtifact and DeploymentRun; include source commit, digest, environment, health and rollback definitions.

## Implementation entry points

packages/core/src/projects; packages/core/src/workflows; packages/core/src/host/secrets.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BF-021
## Acceptance criteria

- Schema tests accept Jira plus GitHub Actions plus IIS, and folder plus local process plus directory; unsupported executor/target capabilities fail preflight.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:** `packages/core/src/projects/deploymentProfile.ts` (new) —

- `DeploymentProfile` (id, name, `projectId`, `environment` as free text, `executor`, `target`,
  optional `healthCheck`, `rollback`, timestamps). `projectId` is an opaque string reference — the
  schema has no field that could branch on or even represent tracker identity, which is what makes
  `feature.md`'s "Implementation boundaries" invariant ("Project issue backend must not determine
  deployment executor or target") true by construction rather than by convention.
- `ExecutorRef` — a closed union covering more than this feature (FX-BF-023) actually runs:
  `direct-process` (this feature's own scope, FX-BE-059), plus `github-actions`/`gitlab-ci`
  (schema-valid now, execution belongs to a later pipeline-managed-deployment feature). `TargetRef`
  likewise: `local-process`/`directory` (this feature's scope) plus `iis` (schema-valid now, needs
  Windows and FX-BF-025 to actually run). **Two validation layers, deliberately separate**:
  `validateDeploymentProfile` checks shape only — a profile naming `github-actions`/`iis` is fully
  valid there, because a profile authored against a not-yet-implemented executor must still be
  readable, storable, and displayable. `preflightDeploymentCapabilities` is the acceptance
  criterion's actual "unsupported executor/target capabilities fail preflight" check: it compares
  against `SUPPORTED_EXECUTOR_KINDS`/`SUPPORTED_TARGET_KINDS` (currently `direct-process` and
  `local-process`/`directory` only) and returns every unsupported capability found, never throwing
  and never stopping at the first one.
- **Reuse over reinvention, twice**: `PublishedArtifact.sourceCommit` reuses TASK-132's
  `WorkflowEvidenceSourceRef` (`{kind:'commit',sha}` | `{kind:'unknown'}`) rather than a second
  "commit or unknown" type; `DeploymentProfile.healthCheck` reuses TASK-141's `RunReadinessProbe`
  rather than a second health-check schema — a deployment health check and a Run service's readiness
  probe are the same concept ("how do I know this process is actually up") at a different point in
  the lifecycle.
- `PublishedArtifact` is modeled as create-once: an `id`, its `sourceCommit`, a `digest` (the
  identity a `DeploymentRun` or a rollback actually checks against — not a filename), a
  `location: {kind:'local-path', path}` (this feature's direct executor only; a registry/URL-based
  location is a later executor's concern), and `createdAt` — nothing in the type or this task writes
  to one after creation. `DeploymentRun` tracks one deployment attempt's own lifecycle (`pending` →
  `deploying` → `healthy`/`failed`/`rolled-back`) referencing a profile and an artifact by id.
- `validateDeploymentProfile` additionally checks per-kind required fields (`workflowFile` for
  github-actions, `pipelineFile` for gitlab-ci, `executable` for local-process, `path` for directory,
  `siteName` for iis) and the rollback policy (`retainCount`, when set, must be a positive integer;
  only meaningful for `keep-previous-artifact`).

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root), one
clean run — **680/680 passing** (18 new). Tests directly exercise the acceptance criteria's own
wording: a `github-actions` executor + `iis` target profile is schema-valid but fails preflight with
both capabilities named; a `direct-process` + `local-process`/`directory` profile is both schema-valid
and preflight-clean; two profiles differing only in `projectId` (standing in for different tracker
backends) validate and preflight identically, proving tracker independence directly rather than by
inspection alone; every per-kind required-field and unknown-kind rejection; rollback `retainCount`
edge cases. `npx tsc --noEmit -p .` in `apps/praxis-desktop/main` and `npm run check-types` in
`apps/praxis-desktop/renderer` — both clean (neither consumes the new module yet).

**Remaining limitations:** This is schema and validation only, matching TASK-141's own precedent —
no storage (`readDeploymentProfile`/`writeDeploymentProfile`, TASK-151's scope), no IPC, no UI, no
artifact-publishing pipeline (computing a real `digest` from packaged bytes), and no executor that
actually deploys anything. Nothing here is Electron-dependent, so unlike almost every other task this
session, there is nothing left to verify that this sandbox's Electron block would otherwise leave
unproven — marked `complete` on that basis.
