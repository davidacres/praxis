---
**Status:** In Progress
**Type:** Feature
type: Feature
id: FX-BF-021
title: "Reproducible failure diagnosis and verification evidence"
status: In Progress
slug: failure-diagnosis
stories: [FX-BE-051, FX-BE-052, FX-BE-053]
issues: docs/issues/features/fx-bf-021-failure-diagnosis/feature-issues.md
updated: 2026-09-07
dependencies: [FX-BE-024, FX-BE-025, FX-BE-041]
---

# FX-BF-021: Reproducible failure diagnosis and verification evidence

**Priority:** High
**Created:** 2026-09-07

## Outcome

Turn local check failures and imported CI evidence into bounded diagnosis sessions, preserving the exact source revision and independently verified outcomes.

## Delivery priority

Committed planning scope; implementation remains Planned. Follow the dependency graph and the roadmap's recommended delivery order.

## Dependencies

- FX-BE-024
- FX-BE-025
- FX-BE-041
## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-051](stories/fx-be-051-failure-evidence-contracts-and-retained-logs/story.md) | Failure evidence contracts and retained logs |
| 2 | [FX-BE-052](stories/fx-be-052-bounded-diagnose-and-verify-workflow/story.md) | Bounded diagnose and verify workflow |
| 3 | [FX-BE-053](stories/fx-be-053-import-ci-failures-with-exact-run-provenance/story.md) | Import CI failures with exact run provenance |

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


