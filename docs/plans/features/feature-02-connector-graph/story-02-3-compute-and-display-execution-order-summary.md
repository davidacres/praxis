# Story 02.3: Compute And Display Execution Order Summary

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** 02.2

## Description
Compute a topological execution order from the graph and present it in a compact summary that users can verify without inspecting every connector manually.

## Implementation Activities
1. Add a topological sort for the persisted graph.
2. Identify start nodes, end nodes, and disconnected nodes.
3. Render an execution-order summary list in the designer.
4. Surface ambiguity or disconnected-node warnings.

## Acceptance Criteria
1. The designer shows an execution order summary.
2. Invalid or disconnected states are surfaced clearly.
3. Graph changes update the summary immediately.
4. `npm run check-types` passes.

## Verification
1. Build a three-node path and verify order.
2. Add a disconnected node and verify the warning.
3. Run `npm run check-types`.
