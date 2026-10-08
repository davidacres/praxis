---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-422
slug: edge-model-validation-and-normalize
title: Edge model: findings predicates, loop budgets, validation and normalizers
status: Done
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 162
---

# TASK-422: Edge model: findings predicates, loop budgets, validation and normalizers

## Description

Extend the edge type with a findings predicate and an optional `loop: { maxIterations }`, update `validateWorkflow` / `findCycle` so only budgeted loop edges may close a cycle, and make `normalizeWorkflow` and `normalizeWorkflowRun` carry every new field.

## Acceptance criteria

- Types: `WorkflowEdge.on` gains a findings condition with predicate variants (`severity`, `count`, `category`, `metric`); `loop.maxIterations` is a bounded integer; a documented ceiling constant exists.
- Validation rejects an unbudgeted cycle (message names the edge), a findings edge whose source declares no `findings` output, a loop edge whose budget is out of range, and a loop edge that does not actually close a cycle.
- Run record gains `loopIterations` (by edge id) and the normalizer copies it, defaulting absent to empty.
- Round-trip tests cover every shipped template and a looping fixture; old definitions without the fields validate unchanged.

## Dependencies

- None

## Comments
