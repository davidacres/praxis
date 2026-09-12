---
**Status:** In Progress
**Type:** Feature
type: Feature
id: FX-BF-022
title: "Managed project runs and diagnostic browser previews"
status: In Progress
slug: managed-run-and-preview
stories: [FX-BE-054, FX-BE-055, FX-BE-056]
issues: docs/issues/features/fx-bf-022-managed-run-and-preview/feature-issues.md
updated: 2026-09-07
dependencies: [FX-BF-021]
---

# FX-BF-022: Managed project runs and diagnostic browser previews

**Priority:** High
**Created:** 2026-09-07

## Outcome

Add project-scoped Run profiles and observable local services, then extend the existing browser with diagnostic tools and verification artifacts.

## Delivery priority

Committed planning scope; implementation remains Planned. Follow the dependency graph and the roadmap's recommended delivery order.

## Dependencies

- FX-BF-021
## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-054](stories/fx-be-054-portable-run-profiles-and-readiness-contracts/story.md) | Portable run profiles and readiness contracts |
| 2 | [FX-BE-055](stories/fx-be-055-managed-service-lifecycle-and-scoped-preview-access/story.md) | Managed service lifecycle and scoped preview access |
| 3 | [FX-BE-056](stories/fx-be-056-browser-diagnostics-and-repeatable-verification/story.md) | Browser diagnostics and repeatable verification |

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


