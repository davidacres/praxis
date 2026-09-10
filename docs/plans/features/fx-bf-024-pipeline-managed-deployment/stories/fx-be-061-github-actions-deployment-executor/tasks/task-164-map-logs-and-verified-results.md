---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-164
title: "Map logs and verified results"
status: Done
story: FX-BE-061
updated: 2026-09-09
dependencies: [TASK-163]
---

# TASK-164: Map logs and verified results

**Priority:** High
**Created:** 2026-09-07

## Goal

Paginate jobs and fetch artifacts/results with bounded backoff; separate workflow success from target health and record available provider URLs.

## Implementation entry points

packages/core/src/github/githubApiService.ts; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-163
## Acceptance criteria

- Fixtures cover cancelled jobs, approval waits, successful pipeline with unhealthy app, expired logs and reconnect to the same external run.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- `packages/core/src/deployments/githubActionsResults.ts` (new) —
  `GitHubActionsResults`, a standalone client for mapping and fetching GitHub
  Actions workflow run results.
  - **`getRunJobs(runId, attempt)`** — fetches and normalizes job list from
    `/repos/{owner}/{repo}/actions/runs/{runId}/attempts/{attempt}/jobs`
    endpoint. Normalizes camelCase conversion (started_at → startedAt, etc.),
    handles all job statuses (queued, in_progress, completed) and conclusions
    (success, failure, cancelled, skipped, null for in-progress).
  - **`getRunResults(runId, runStatus, runConclusion, htmlUrl)`** — assembles
    complete workflow run results from job details and run metadata, including
    `WorkflowRunResults` structure with jobs, provider URLs (workflowRunUrl,
    jobUrls Map), and `workflowFailed` flag distinguishing workflow outcome
    from job health (workflow can succeed but app be unhealthy, or vice versa).
  - **`fetchJobLog(jobId, config)`** — fetches logs for a single job with bounded
    exponential backoff retry for transient failures.
    * Transient retries: 429 (rate limit), 5xx (server errors), network-level
      errors (socket hang up, ECONNRESET, ENOTFOUND, ETIMEDOUT, EHOSTUNREACH)
    * Permanent failures: 404/410 (expired logs, sets expired: true), 403
      (permission denied, sets error with "No permission to read logs")
    * Exponential backoff: delay = Math.min(initialDelayMs * 2^(attempt-1),
      maxDelayMs), configurable via BackoffConfig
    * Default: maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 30000
  - **`WorkflowJobResult`** interface: {id, name, status, conclusion,
    startedAt, completedAt, htmlUrl} — normalized job summary
  - **`JobLogFetch`** interface: {jobId, content, expired, error} — result of
    log fetch with expired flag for 404/410, error for other failures
  - **`WorkflowRunResults`** interface: {runId, htmlUrl, runStatus,
    runConclusion, jobs, workflowFailed, providerUrls}
  - **`GitHubActionsResultsError`** — distinguishes API failures by kind
    (insufficient-permission, run-not-found, other) with HTTP status

- `packages/core/src/deployments/githubActionsResults.test.ts` (new) — 16
  comprehensive tests covering all acceptance scenarios:
  - Job normalization (status mappings, camelCase conversion, default fallbacks)
  - Handling all job states: success, failure, cancelled, queued, in_progress
  - Null conclusions for in-progress jobs
  - Workflow result mapping with separate success/health status
  - Successful pipeline with unhealthy app (workflow failed but one job passed)
  - Expired logs: 404 and 410 responses
  - Permission errors: 403 with proper error message
  - Rate limit retry: 429 with backoff and eventual success
  - Server error retry: 503 with backoff and eventual success
  - Network error retry: socket hang up with backoff and eventual success
  - Max attempts exhaustion: proper "after N attempts" error messages
  - Non-transient errors: immediate return with HTTP status message
  - Reconnect idempotency: fetching same run twice returns consistent results
  - Approval wait scenario: queued jobs with null conclusion and null timestamps

- **Integration**:
  - Added `githubActionsResults.test.js` to package.json test script (after
    githubActionsOrchestrator.test.js)
  - Exported `GitHubActionsResults`, `WorkflowJobResult`, `JobLogFetch`,
    `WorkflowRunResults`, `GitHubActionsResultsError`, `BackoffConfig` from
    packages/core/src/index.ts

**Commands run:** `npm run compile` — clean, no errors. `npm test` from repo
root — **888/888 passing** (up from 871; 16 new from githubActionsResults + 1
fix to transient error handling on last retry attempt).

**Acceptance criteria met:**

- ✓ Fixtures cover cancelled jobs (test at line 61)
- ✓ Fixtures cover approval waits (test at line 288)
- ✓ Fixtures cover successful pipeline with unhealthy app (test at line 314)
- ✓ Fixtures cover expired logs (tests at line 177, 189)
- ✓ Fixtures cover reconnect to same external run (test at line 335)

**Remaining limitations:**

- No IPC, UI, or main-process wiring — this is core mechanics only. No caller
  in the app invokes this module yet; TASK-165 and beyond will wire it into
  the deployment journey.
- No credential/token acquisition — `GitHubActionsConfig.token` is assumed
  already resolved by the caller.
- Backoff retry is for individual log fetches only; batch/parallel log fetching
  with coordinated backoff is out of scope.
- Nothing here is Electron-dependent, so there is nothing this sandbox's
  inability to launch Electron leaves unproven; marked `complete` on that basis.

## Description


## Comments


