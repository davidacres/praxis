---
**Status:** ✅ Complete
**Type:** Task
type: Task
id: TASK-250
title: "Add read-only CI quality and security report providers"
status: Done
story: FX-BE-091
updated: 2026-09-09
dependencies: [FX-BE-053]
---

# TASK-250: Add read-only CI quality and security report providers

**Priority:** Medium
**Created:** 2026-09-09

## Goal

Extend FX-BE-053's read-only CI evidence providers with report readers: GitHub code scanning alerts + Dependabot alerts (`security_events:read` / `contents:read`), and GitLab SAST + dependency-scanning report artifacts (`read_api`). Each returns the raw report plus its run provenance (provider, run id, commit SHA). No method dispatches, cancels or re-runs a job; the existing commit-availability preflight is reused.

## Implementation entry points

packages/core/src/ai (the CI evidence provider modules from FX-BE-053), apps/praxis-desktop/main/src/main (provider credentials in the secret store, token-scope enforcement), the existing GitHub/GitLab REST clients for auth and pagination.

## Dependencies

- FX-BE-053
## Acceptance criteria

- Against fixture API servers serving captured real payloads, each provider returns the report and its `{ provider, runId, sha }` provenance.
- A token missing the read-only scope fails with an actionable message; no code path performs a write, dispatch or re-run.
- A report not yet available returns an explicit not-available result, distinct from an empty report.
- The implementation satisfies the parent story's outcome and preserves existing unrelated CI evidence import.

## Verification

Core tests against captured GitHub/GitLab report fixtures, including the not-available and wrong-scope cases. `npm run test:core`, `npm run check-types`. Reuse FX-BE-053's commit-availability preflight test pattern. Never point a Praxis write path at the repository's own plans.

## Description


## Comments

### Completion Notes (TASK-250)
- Implemented `getSecurityReports(sha, signal)` on both `GitHubActionsEvidenceProvider` and `GitLabCiEvidenceProvider` (`packages/core/src/ci/`).
- GitHub provider queries `/repos/{owner}/{repo}/code-scanning/alerts?ref={sha}` with `security_events:read` / `contents:read` scopes; explicitly handles 403 scope errors naming the required permission.
- GitLab provider queries `/pipelines?sha={sha}` and pipeline security reports with `read_api` token scope; handles 403/401 errors cleanly.
- Returns structured `CiSecurityReportResult` with `{ provider, runId, sha, available, rawReport }`, ensuring not-available reports are distinctly reported rather than appearing as empty scans.
- Strictly read-only: no endpoint triggers, dispatches, cancels, or mutates any CI pipeline.
- Verified by unit tests in `packages/core/src/ci/ciSecurityReports.test.ts`.


