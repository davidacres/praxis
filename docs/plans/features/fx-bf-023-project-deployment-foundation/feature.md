---
**Status:** In Progress
**Type:** Feature
type: Feature
id: FX-BF-023
title: "Project deployment profiles and direct execution"
status: In Progress
slug: project-deployment-foundation
stories: [FX-BE-057, FX-BE-058, FX-BE-059, FX-BE-060]
issues: docs/issues/features/fx-bf-023-project-deployment-foundation/feature-issues.md
updated: 2026-09-07
dependencies: [FX-BF-021]
---

# FX-BF-023: Project deployment profiles and direct execution

**Priority:** High
**Created:** 2026-09-07

## Outcome

Separate project tracker, deployment executor and target; implement direct deployment and a durable verified lifecycle before provider-specific integration.

## Delivery priority

Committed planning scope; implementation remains Planned. Follow the dependency graph and the roadmap's recommended delivery order.

## Dependencies

- FX-BF-021
## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-057](stories/fx-be-057-independent-deployment-profiles-and-immutable-artifacts/story.md) | Independent deployment profiles and immutable artifacts |
| 2 | [FX-BE-058](stories/fx-be-058-durable-deployment-state-and-workflow-operations/story.md) | Durable deployment state and workflow operations |
| 3 | [FX-BE-059](stories/fx-be-059-script-based-direct-deployment-executor/story.md) | Script-based direct deployment executor |
| 4 | [FX-BE-060](stories/fx-be-060-deployment-profile-and-history-experience/story.md) | Deployment profile and history experience |

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


