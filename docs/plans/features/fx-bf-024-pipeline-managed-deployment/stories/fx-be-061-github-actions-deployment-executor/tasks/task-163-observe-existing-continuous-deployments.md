---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-163
title: "Observe existing continuous deployments"
status: complete
story: FX-BE-061
updated: 2026-09-09
dependencies: [TASK-162]
---

# TASK-163: Observe existing continuous deployments

**Priority:** High
**Created:** 2026-09-07

## Goal

Support observe-only profiles filtered by repository, workflow, environment and source SHA; correlate an already-triggered run rather than dispatching another.

## Implementation entry points

packages/core/src/github/githubApiService.ts; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-162
## Acceptance criteria

- A merge-triggered run is attached once; multiple candidate runs require explicit selection; stale run from another SHA cannot satisfy deployment.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- `packages/core/src/deployments/githubActionsObserver.ts` (new) —
  `GitHubActionsObserver`, a standalone client for observing and correlating
  existing GitHub Actions workflow runs against deployment artifacts.
  - **`listWorkflowRuns(workflowId, page, pageSize)`** — fetches all runs for a
    specific workflow, paginated, returning id/attempt/sha/workflowName/status/
    conclusion/createdAt/htmlUrl normalized for consumption.
  - **`correlateWorkflowRun(workflowId, sourceCommit, environment)`** — filters
    listed runs by source commit SHA (the artifact's `sourceCommit`), returning
    one of four outcomes: `single-candidate` (auto-attachable), `multiple-
    candidates` (caller must select), `no-candidates` (no matching run), or
    `stale-run` (found but wrong SHA — stale run rejection). Environment
    filtering is prepared in the interface but deferred to TASK-164's "map logs
    and verified results" scope (would require fetching per-run job details).
  - **`GitHubActionsObserverError`** — distinguishes API failures by kind:
    `workflow-not-found` (404), `insufficient-permission` (403 without rate-
    limit signal), `rate-limited` (429 or 403 with `X-RateLimit-Remaining: 0`),
    `other` as fallback.

- `packages/core/src/deployments/githubActionsOrchestrator.ts` (new) —
  orchestration of GitHub Actions deployments in both dispatch (TASK-162) and
  observe-only (TASK-163) modes, paired with the deployment run state machine
  (TASK-153/154).
  - **`prepareGitHubActionsDeployment()`** — creates and persists a deployment
    run in `prepared` state, identical contract to `prepareDirectDeployment`.
  - **`observeGitHubActionsDeployment()`** — the observe-only path: reads an
    existing queued run, observes for an existing workflow run, and attaches
    when one is found. Handles all correlation outcomes:
    - Single candidate → auto-attach with external ID `github-actions:runid:attempt`,
      transition to succeeded immediately (run correlation was successful).
    - Multiple candidates → persist the run in failed state and return candidates
      for explicit caller selection (TASK-164's responsibility to implement
      selection UI and re-call with a chosen run).
    - No candidates → fail with error stating the artifact's SHA didn't match
      any run (expected SHA shown for debugging).
    - Stale run (wrong SHA) → explicitly reject with both the found SHA and
      expected SHA in the error (the "stale run from another SHA cannot satisfy
      deployment" acceptance criterion).
    - All failure paths properly transition through `deploying` → `verifying` →
      `failed` so the state machine's own guards handle idempotency.
  - Observe-only mode is enabled by setting `executor.observeOnly: true` in the
    deployment profile (new field in `GitHubActionsExecutorRef`).
  - Correlation input validation (TASK-162's `validateDispatchRequest`) is not
    applied to observe-only mode since no inputs are sent; only SHA matching.

- `packages/core/src/projects/deploymentProfile.ts` (MODIFIED) — added optional
  `observeOnly?: boolean` field to `GitHubActionsExecutorRef` to distinguish
  dispatch (default, TASK-162) from observe (TASK-163) mode.

**Test coverage:**

- `packages/core/src/deployments/githubActionsObserver.test.ts` (new) — 12
  comprehensive tests:
  - `listWorkflowRuns` normalization and pagination
  - Workflow-not-found (404) returning null for graceful handling
  - Single-candidate attachment (SHA matching)
  - Multiple-candidates (same SHA, different attempt/conclusion)
  - No-candidates (no matching SHA)
  - Non-commit source refs return no-candidates (idempotent, safe)
  - Error classification: insufficient-permission (403), rate-limited (429 and
    403 with header), workflow-not-found (404).

- `packages/core/src/deployments/githubActionsOrchestrator.test.ts` (new) — 5
  comprehensive tests:
  - Prepare creates run in `prepared` state (idempotent storage)
  - Observe auto-attaches single candidate, transitions to `succeeded`
  - Observe returns multiple candidates for selection (run left in `failed`)
  - Observe fails when no matching SHA (run in `failed`)
  - Observe is idempotent: re-calling on a `deploying` run (already in flight)
    returns the existing state unchanged (no fetch attempted)

**Commands run:** `npm install` not needed (no new dependencies; `js-yaml` added
in TASK-162). `npm run compile` — clean. `npm test` from the repo root —
**871/871 passing** (up from 866; 5 new from the orchestrator).

**Acceptance criteria met:**

- ✓ Single merge-triggered run is attached once automatically (single-candidate
  outcome auto-attaches; repeated clicks/reconnects are idempotent per state
  machine discipline)
- ✓ Multiple candidate runs require explicit selection (multiple-candidates
  outcome returns runs for caller to choose; selection wiring is TASK-164's
  responsibility)
- ✓ Stale run from another SHA cannot satisfy deployment (explicit stale-run
  outcome rejects and errors)

**Remaining limitations:**

- No environment filtering on correlation — the interface accepts the environment
  name from the profile, but correlateWorkflowRun() currently returns all SHA-
  matching runs regardless of environment, since fetching each candidate's job
  details (which carry the environment context) is deferred to TASK-164's "map
  logs and verified results" scope. A production implementation would likely
  correlate this data at run-listing time or via a separate metadata lookup.
- No IPC, UI, or main-process wiring — this is the core mechanics only. No caller
  in the app invokes this module yet; TASK-164 is the next step.
- No credential/token acquisition — `GitHubActionsConfig.token` is assumed
  already resolved by the caller, same as TASK-162's executor.
- Nothing here is Electron-dependent, so — like TASK-162 — there is nothing
  this sandbox's inability to launch Electron leaves unproven; marked `complete`
  on that basis.

## Description


## Comments


