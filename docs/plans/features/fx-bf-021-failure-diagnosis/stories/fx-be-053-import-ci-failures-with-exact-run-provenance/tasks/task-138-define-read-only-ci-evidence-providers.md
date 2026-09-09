---
type: Task
id: TASK-138
title: "Define read-only CI evidence providers"
status: complete
story: FX-BE-053
updated: 2026-09-07
dependencies: [FX-BE-052]
---

# TASK-138: Define read-only CI evidence providers

**Priority:** High
**Created:** 2026-09-07

## Goal

Resolve explicit repository/project and pipeline connection independently of tracker; paginate runs/jobs and capture run attempt, head SHA, job URL, logs and available test artifacts.

## Implementation entry points

packages/core/src/github; packages/core/src/gitlab; renderer/src/workflows. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-052
## Acceptance criteria

- Mock pagination, missing permissions, expired artifacts and unavailable SHA; a Jira project can select GitHub CI and a folder project can select GitLab CI.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:** `packages/core/src/ci/`:
- `ciEvidenceProvider.ts` — the shared `CiEvidenceProvider` contract (`listFailedRuns`,
  `listJobs(runId, attempt)`, `getJobLog`). `CiRunSummary.source` reuses
  `WorkflowEvidenceSourceRef` (`workflows/workflowEvidence.ts`) rather than a new type — a CI run's
  head commit and a local check's captured commit are the same concept, so a CI run can feed
  `buildDiagnosisBrief` with no conversion once TASK-140 connects them.
- `githubActionsEvidenceProvider.ts` / `gitLabCiEvidenceProvider.ts` — standalone read-only clients
  (constructor-injected `fetchImpl`, same pattern as `GitHubApiService`/`GitLabApiService`), each
  taking **only** an explicit `{baseUrl, owner/repo or projectPath, token}` — neither reads a
  project's issue-tracker connection at all, which is what makes "a Jira project can select GitHub CI
  and a folder project can select GitLab CI" true structurally rather than by a special case: nothing
  here knows or cares what tracker a project uses.
- `attempt` is a required, explicit parameter on `listJobs` for both providers (GitLab's contract
  keeps it only for shape symmetry — GitLab re-runs mint a new pipeline id rather than a further
  attempt of the same one) — never inferred as "whatever is latest now".
- An expired/reaped log (`404`/`410` on GitHub, `404` on GitLab's trace endpoint) returns
  `{ content: '', expired: true }`, never thrown as an error; a `403` throws a distinct, named
  permission message. A run missing its head SHA/pipeline sha reports the explicit
  `{ kind: 'unknown' }` source rather than a guessed or empty string.

**Commands run:** `npm run test:core` — 522/522 (16 new: paginated listing via GitHub's
`total_count`/GitLab's `x-next-page`, a run with no SHA reporting `unknown`, jobs scoped to a
specific attempt, a `403` on listing distinct from a `404`/`410` "expired" on a log/trace, and a
missing owner/repo/project throwing before any network call). `check-types` — clean.

**Remaining limitations:** No connection/config UI yet — a caller must already have
`{owner, repo, token}` or `{projectPath, token}` in hand; wiring that to an actual connection picker
(so a project can literally *select* which CI source to read) is TASK-139's explicit job ("Add
failure selection and refresh"). Real GitHub/GitLab API behaviour (rate limits, exact error body
shapes on Enterprise/self-hosted instances) is unverified beyond what these fixtures assert — this
task's own acceptance criteria scope verification to mocked fixtures, and real-account testing
remains an explicit opt-in per the story's Verification section.
