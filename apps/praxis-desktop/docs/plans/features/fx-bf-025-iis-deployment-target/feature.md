---
**Status:** 📋 Proposed
**Type:** Feature
type: Feature
id: FX-BF-025
title: "IIS deployment target and recovery templates"
status: To Do
slug: iis-deployment-target
stories: [FX-BE-064, FX-BE-065, FX-BE-066]
issues: docs/issues/features/fx-bf-025-iis-deployment-target/feature-issues.md
updated: 2026-09-07
dependencies: [FX-BF-023]
---

# FX-BF-025: IIS deployment target and recovery templates

**Priority:** High
**Created:** 2026-09-07

## Outcome

Deliver immutable .NET/web artifacts to an explicit IIS site using a supported Windows executor, locally first and through existing pipeline runners for remote environments.

## Delivery priority

Committed planning scope; implementation remains Planned. Follow the dependency graph and the roadmap's recommended delivery order.

## Dependencies

- FX-BF-023
## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-064](stories/fx-be-064-iis-capability-preflight-and-target-configuration/story.md) | IIS capability preflight and target configuration |
| 2 | [FX-BE-065](stories/fx-be-065-iis-install-health-and-explicit-rollback/story.md) | IIS install health and explicit rollback |
| 3 | [FX-BE-066](stories/fx-be-066-iis-end-to-end-proof-and-operational-guidance/story.md) | IIS end-to-end proof and operational guidance |

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


