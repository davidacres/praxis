---
**Status:** ✅ Complete
**Type:** Task
type: Task
id: TASK-239
title: "Add metric and severity threshold gate policy"
status: Done
story: FX-BE-087
updated: 2026-09-09
dependencies: [TASK-237]
---

# TASK-239: Add metric and severity threshold gate policy

**Priority:** High
**Created:** 2026-09-09

## Goal

Let a gate carry a threshold condition evaluated by the engine from the owning node's `CheckFindings`: `metrics.<name> >= n` (or `<=`), or `findings(severity >= <level>).count == 0`. `evaluateGates` reads the parsed result rather than only the node outcome. Thresholds compose strictest-wins: a project may raise a minimum or lower a maximum; `WorkflowPolicyStore.effectiveForProject` and validation refuse a compose that loosens the org's bar.

## Implementation entry points

packages/core/src/workflows/workflowTypes.ts (threshold condition type on the gate/policy), workflowGates.ts (`evaluateGates` threshold evaluation, blocking detail text), workflowValidation.ts (a gate with a threshold must have an owning node that produces `findings`), the policy composition path.

## Dependencies

- TASK-237
## Acceptance criteria

- A gate with `metrics.newCodeCoveragePct >= 80` is `failed` at 78, `passed` at 82, and `pending` until the owning node finishes; the blocking detail names the metric and the actual value.
- A gate with `findings(severity >= high).count == 0` fails with one high finding present and passes with none.
- Composing a project policy that lowers the org coverage minimum or raises the org severity ceiling is refused with a stated reason; tightening composes.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows (exit-code-only gates still behave exactly as before).

## Verification

Unit tests for threshold evaluation across pending/pass/fail, and for strictest-wins compose accept/refuse. `npm run test:core`, `npm run test:desktop:workflows`, `npm run check-types`. Prove the loosen-refusal guard fails against the pre-change composition. Never point a Praxis write path at the repository's own plans.

## Description


## Comments

- Added threshold contract types in `workflowTypes.ts`: `MetricThresholdCondition`, `SeverityThresholdCondition`, and `GateThresholdCondition`.
- Extended `evaluateGates` in `packages/core/src/workflows/workflowGates.ts` to evaluate metric and severity threshold conditions against `state.findings` when the owning node completes.
- Implemented strictest-wins policy composition in `packages/core/src/workflows/workflowStore.ts` (`composeWorkflowPolicies`), explicitly throwing an error if a project attempts to loosen organization thresholds (lowering coverage minimums, raising maximums, raising severity count allowances, or raising severity rank floors).
- Enforced validation rules in `workflowValidation.ts` ensuring gates declaring thresholds depend on nodes declaring `findings` output.
- Added comprehensive unit tests in `workflowThresholdGates.test.ts`.


