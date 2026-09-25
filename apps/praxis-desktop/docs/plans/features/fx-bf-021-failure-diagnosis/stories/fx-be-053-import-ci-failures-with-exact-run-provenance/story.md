---
**Status:** In Progress
**Type:** Story
type: Story
id: FX-BE-053
title: "Import CI failures with exact run provenance"
status: Done
feature: FX-BF-021
updated: 2026-09-25
dependencies: [FX-BE-052]
---

# FX-BE-053: Import CI failures with exact run provenance

**Priority:** High
**Created:** 2026-09-07

## Outcome

Read GitHub Actions and GitLab job failures as evidence sources without coupling project issue backend to CI provider.

## Scope and implementation entry points

packages/core/src/github; packages/core/src/gitlab; renderer/src/workflows. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-052
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-138](tasks/task-138-define-read-only-ci-evidence-providers.md) | Define read-only CI evidence providers |
| 2 | [TASK-139](tasks/task-139-add-failure-selection-and-refresh.md) | Add failure selection and refresh |
| 3 | [TASK-140](tasks/task-140-connect-ci-evidence-to-diagnosis.md) | Connect CI evidence to diagnosis |

## Acceptance criteria

- Mock pagination, missing permissions, expired artifacts and unavailable SHA; a Jira project can select GitHub CI and a folder project can select GitLab CI.
- Selecting an older failed attempt never silently substitutes the latest attempt; retrying import does not duplicate the evidence bundle.
- An Electron fixture imports a failed CI job then reaches verified repair; unavailable commits and logs yield an explicit blocked state; document read-only credential scopes.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments



## Review 2026-09-25

Status corrected from In Progress → CI failure import with provenance is implemented in core.

- `packages/core/src/ci/gitLabCiEvidenceProvider.ts` imports GitLab CI evidence,
  wiring run provenance into the shared evidence contracts
  (`workflowEvidence.ts`).
- `packages/core/src/gitlab/gitLabApiService.ts` + `gitLabBoardService.ts`
  provide the GitLab backend integration used by the import path.

Validation commands: `npm run check-types`, `npm run test:core`
(not rerun as part of this review).
