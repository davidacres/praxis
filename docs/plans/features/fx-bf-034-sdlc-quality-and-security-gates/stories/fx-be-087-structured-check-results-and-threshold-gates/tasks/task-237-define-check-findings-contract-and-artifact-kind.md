---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-237
title: "Define the CheckFindings contract and the findings artifact kind"
status: To Do
story: FX-BE-087
updated: 2026-09-09
dependencies: [FX-BE-020, FX-BE-024]
---

# TASK-237: Define the CheckFindings contract and the findings artifact kind

**Priority:** High
**Created:** 2026-09-09

## Goal

Add `findings` to `WorkflowArtifactKind` and define `CheckFindings`: `findings[]` with `{ fingerprint, ruleId?, file?, line?, severity: 'info'|'low'|'medium'|'high'|'critical', category, message, suggestion? }` and `metrics: Record<string, number>`. Fingerprint is a stable hash over rule id + normalised location + message, so the same underlying issue keeps its id across runs. A node may declare a `findings` output; downstream `inputs` may name it.

## Implementation entry points

packages/core/src/workflows/workflowTypes.ts (artifact kind, `CheckFindings` type, fingerprint helper); packages/core/src/workflows/workflowValidation.ts (a `findings`-kind output is structurally allowed on check and agent-task nodes). Paths prefixed renderer/src are under apps/praxis-desktop.

## Dependencies

- FX-BE-020
- FX-BE-024
## Acceptance criteria

- `CheckFindings` and the `findings` artifact kind are exported from core; a workflow with a check node declaring `findings` and a gate consuming it validates.
- `fingerprint` is deterministic: the same finding input yields the same id across two computations, and a location or message change yields a different one.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows (existing templates and the `report`/`test-results` kinds are untouched).

## Verification

Unit tests for the fingerprint helper (stability and sensitivity) and for validation accepting/rejecting `findings` outputs. `npm run test:core` and `npm run check-types`. No UI in this task. Never point a Praxis write path at the repository's own plans.

## Description


## Comments


