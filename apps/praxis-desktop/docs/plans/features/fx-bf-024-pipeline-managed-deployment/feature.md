---
**Status:** In Progress
**Type:** Feature
type: Feature
id: FX-BF-024
title: "Pipeline-managed deployment and continuous delivery observation"
status: In Progress
slug: pipeline-managed-deployment
stories: [FX-BE-061, FX-BE-062, FX-BE-063]
issues: docs/issues/features/fx-bf-024-pipeline-managed-deployment/feature-issues.md
updated: 2026-09-07
dependencies: [FX-BF-023]
---

# FX-BF-024: Pipeline-managed deployment and continuous delivery observation

**Priority:** High
**Created:** 2026-09-07

## Outcome

Use existing GitHub Actions and GitLab CI to perform deployment, supporting both explicit triggering and observation of merge-triggered CD without duplicate runs.

## Delivery priority

Committed planning scope; implementation remains Planned. Follow the dependency graph and the roadmap's recommended delivery order.

## Dependencies

- FX-BF-023
## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-061](stories/fx-be-061-github-actions-deployment-executor/story.md) | GitHub Actions deployment executor |
| 2 | [FX-BE-062](stories/fx-be-062-gitlab-ci-deployment-executor/story.md) | GitLab CI deployment executor |
| 3 | [FX-BE-063](stories/fx-be-063-pipeline-setup-and-recovery-experience/story.md) | Pipeline setup and recovery experience |

## Implementation boundaries

Shared domain logic belongs in core; Electron main owns processes, filesystem, credentials and privileged IPC. Renderer imports core types only. Reuse the current workflow engine, Agent Hub and themed in-app dialogs. Project issue backend must not determine deployment executor or target. Files created by the application follow `<name>.praxis.<ext>` with shared filename constants; plan documents retain this repository's established feature/story/task names.

## Close when

Every story and child task is implemented and verified; required integrations have fixture evidence and any real-runtime proof is documented. The feature is a completion roll-up, not a prerequisite for its own children. Planned dependencies are prerequisites to start; containment is recorded through feature/story metadata.

## Verification

Review the complete feature journey and documented support matrix. Follow AGENTS.md for core boundaries, source schema inspection, UI verification and temporary fixtures. Do not claim production support from mocked integration tests alone.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


