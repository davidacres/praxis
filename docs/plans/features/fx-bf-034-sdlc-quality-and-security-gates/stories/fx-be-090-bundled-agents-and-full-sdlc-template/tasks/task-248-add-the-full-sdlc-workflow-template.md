---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-248
title: "Add the full-sdlc workflow template"
status: planned
story: FX-BE-090
updated: 2026-09-09
dependencies: [TASK-247, FX-BE-088, FX-BE-089]
---

# TASK-248: Add the full-sdlc workflow template

**Priority:** Medium
**Created:** 2026-09-09

## Goal

Add `fullSdlcTemplate()` to `workflowTemplates.ts` and register it in `builtInWorkflowTemplates()`:
`Plan → Implement → (Lint ∥ Type-check ∥ Unit tests + coverage ∥ SAST ∥ Secrets ∥ SCA ∥ AI review) → Gates → Approve`, with an optional trailing `Deploy` node (advisory edge, not a gate). `qa` is owned by lint + type-check + tests/coverage converging on a join with a coverage threshold; `security` by the FX-BE-088 scanner join; `review` by the FX-BE-089 structured reviewer with its fix loop. Check commands are placeholders resolved per stack in TASK-249. Agent ids are the TASK-247 bundled ids.

## Implementation entry points

packages/core/src/workflows/workflowTemplates.ts (the definition, `builtInWorkflowTemplates`), workflowValidation.ts (must pass `validateWorkflow`), the readiness path (`assessTemplateReadiness` resolves the bundled agents).

## Dependencies

- TASK-247
- FX-BE-088
- FX-BE-089
## Acceptance criteria

- `fullSdlcTemplate()` passes `validateWorkflow`; `assessTemplateReadiness` reports `structureOk` and `agentsOk` against the bundled catalog with no project configuration.
- Each gate is multi-owner as described and rests on FX-BE-087/088/089 structures; `Approve` requires `qa`, `security`, `review` with no bypass.
- The optional `Deploy` node is on an advisory edge — its absence or failure does not block `Approve`.
- The implementation satisfies the parent story's outcome and preserves existing unrelated templates (`governed-delivery`, `quick-change` unchanged).

## Verification

Core tests: template validation, readiness against a bundled-agent catalog snapshot, gate ownership. A scripted end-to-end run through the template on a Node fixture. `npm run test:core`, `npm run test:desktop:workflows`, `npm run check-types`. Never point a Praxis write path at the repository's own plans.

## Description


## Comments


