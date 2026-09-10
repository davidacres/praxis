---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-160
title: "Add deployment history and promotion"
status: In Progress
story: FX-BE-060
updated: 2026-09-09
dependencies: [TASK-159]
---

# TASK-160: Add deployment history and promotion

**Priority:** High
**Created:** 2026-09-07

## Goal

Link issues, source commit, artifact digest, workflow run and target URL; promote the same digest across environments with fresh environment-specific approval.

## Implementation entry points

renderer/src/deployments (new); renderer/src/app; docs/user-guide.md. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-159
## Acceptance criteria

- Test and production records share artifact digest but retain separate approval and health evidence; unknown and rolled-back runs are distinguishable.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- **`packages/core/src/projects/deploymentRunState.ts`** — `DeploymentRun`
  gains four optional, immutable-once-set linking fields: `issueKey`/
  `issueConnectionId` (same discipline `WorkflowRun` already uses),
  `workflowRunId` (links a deployment back to the delivery pipeline run
  that produced its artifact), `targetUrl` (where it can be reached once
  live, when known at prepare time — never inferred). `createDeploymentRun`
  accepts them; source commit is deliberately **not** duplicated onto the
  run — it already lives on `PublishedArtifact.sourceCommit` (TASK-150),
  and a run only needs `artifactId`/`artifactDigest` to look that up.
  `deploymentRunStore.ts`'s `normalizeDeploymentRun` round-trips all four.
  No existing field, command, or transition changed — purely additive, and
  every existing `deepEqual` round-trip test in
  `deploymentRunState.test.ts`/`deploymentRunStore.test.ts` still passes
  unchanged because the new fields default to entirely absent (not empty
  strings) when not supplied.
- **`packages/core/src/deployments/directDeploymentOrchestrator.ts`** —
  `prepareDirectDeployment`'s input gains the same four optional fields,
  threaded straight into `createDeploymentRun`.
- **Promotion — the acceptance criterion, proven directly, not assumed**: a
  new test in `directDeploymentOrchestrator.test.ts` deploys one published
  artifact to a "test" profile, then promotes the *exact same* artifact
  (same `PublishedArtifact`, same digest) to a "production" profile via a
  second `prepare`/`approve`/`deploy` sequence. Asserts: both runs share
  `artifactDigest`; each has its own `DeploymentApproval` bound to its own
  `deploymentProfileId`/`environment`/`approvedBy`; each has an independent
  event log with its own `health-verified` event; each target directory
  received its own copy (promotion never shares or moves files between
  targets). A companion test proves the mechanism that makes this safe:
  `isApprovalValid` (TASK-153, unchanged) binds an approval to the run's
  *own* prepared profile identity — passing a different profile to
  `approveDirectDeployment` cannot make an approval "belong" to that
  profile, it is simply refused as invalid.
- **Main process — a real artifact store**, missing since TASK-152 (core
  only) and deliberately deferred by TASK-158: `deploymentArtifactStore.ts`
  (new) — `deploymentArtifacts.json` under `userData`, the same
  `JsonKeyValueStore` convention `deploymentManagerInstance.ts` uses for
  runs. Deliberately **not** the project's `.praxis/deployments/` folder —
  an artifact's `location.path` is a machine-local fact about where a build
  happened to land, the same separation already drawn between a profile
  (committed, project folder) and a run (machine-local, `userData`).
  Refuses to replace an existing artifact id, matching `PublishedArtifact`'s
  own "immutable, created once" contract. `deploymentArtifactIpc.ts` (new)
  exposes `deployments:publishArtifact/listArtifacts/listAllArtifacts/
  getArtifact`; `deployments:prepare`'s IPC handler now accepts the
  optional linking-context object. All wired through `ipcContracts.ts`'s
  `DeploymentsIpc` and `preload/index.ts`.
- **Renderer — history and promotion UI** (`DeploymentsPage.tsx`, extended):
  - `DeploymentHistoryPanel` — a "publish an artifact" mini-form (pick a
    built output folder via the existing `window.praxis.dialog.pickFolder`,
    the same picker `NewProjectWizard`/`ImportProjectsWizard` already use);
    the profile's own published artifacts, each with a "promote to…"
    profile selector wired straight to `prepare`→`approve` against the
    chosen profile with the *same* artifact object; and the run list itself
    — status chip, short digest, issue/workflow/target-URL links when
    present, approval summary, and the run's own `endedReason`.
  - **"Unknown and rolled-back runs are distinguishable"**: a
    `STATUS_CHIP` table gives all eleven `DeploymentRunStatus` values a
    distinct label and tone — `unknown` reads "Unknown — outcome
    unconfirmed" in the danger tone (it still needs attention),
    `rolled-back` reads "Rolled back" in the muted tone (a settled, understood
    outcome) — deliberately never collapsed into one generic "not running"
    treatment, which is exactly the distinction this criterion names.
- **`docs/user-guide.md`** — a new "Deployments" subsection under Main
  workflows, covering profiles, publish/deploy/rollback, promotion, and the
  machine-local nature of credential bindings, at the same terse level of
  detail the rest of the guide uses (the Run feature, TASK-141-149, never
  received an equivalent section either — this is the first deployment-
  related doc content in the guide).

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. Targeted
`node --test` on `deploymentRunState.test.js`/`deploymentRunStore.test.js`/
`directDeploymentOrchestrator.test.js` together — 66/66 (5 new: 2 linking-
field round-trip tests, 2 promotion tests, 1 approval-binding test). `npm
run test:core` from the repo root (confirmed no stray background test/tsc
processes first) — **834/834 passing** (up from 829). `npx tsc --noEmit -p
.` in `apps/praxis-desktop/main` — clean. `npm run check-types` in
`apps/praxis-desktop/renderer` (including `checkCoreImports.cjs`) — clean.

**Remaining limitations:**

- No Electron capture/verification was possible in this sandbox — the
  publish/promote UI compiles clean end-to-end but was never exercised
  against a running app, a real folder picker dialog, light/dark themes, a
  narrow viewport, or keyboard focus order. Marked `in-progress` for this
  reason, consistent with every other UI task in this feature.
- `targetUrl`/`workflowRunId` are accepted by `prepare`'s IPC handler and
  the orchestrator, but nothing in the renderer UI actually collects or
  passes them yet (the publish/promote flow calls `prepare` with no
  `context` argument) — the plumbing exists end-to-end, but no caller
  populates it. A future task wiring an actual delivery-workflow → deploy
  handoff is the natural place to supply `workflowRunId`.
- The health-check-fails-then-restore flow still requires the separate
  explicit `rollback` action (TASK-158's own deliberate design, unchanged
  here) — the history panel shows a failed run's reason but does not yet
  offer a one-click rollback button; that is UI polish, not a missing
  capability (the IPC action already exists and is exercised by TASK-158's
  own tests).
- `publishArtifact`'s `sourceCommit` defaults to `{kind: 'unknown'}` from
  the renderer today — nothing in this task wires an actual git commit sha
  in from the project's own repository state. "Link... source commit" is
  therefore structurally supported (the field exists, round-trips, and
  would display if populated) but not yet populated end-to-end from a real
  build.

## Description


## Comments


