# Story 02.2: Add Cycle And Duplicate-Edge Validation

**Status:** Obsolete
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** 02.1

## Description
Prevent graph configurations that make execution order invalid, specifically duplicate edges and cycles.

## Implementation Activities
1. Add duplicate-edge checks before persisting a connector.
2. Add cycle detection to the graph model.
3. Surface friendly validation messages in the designer.
4. Keep existing valid state intact when invalid actions are attempted.

## Acceptance Criteria
1. Duplicate connectors are blocked.
2. Cycles are blocked.
3. Validation messages are visible and actionable.
4. `npm run check-types` passes.

## Verification
1. Attempt to add the same edge twice.
2. Attempt to create a cycle across three nodes.
3. Run `npm run check-types`.

## Dependencies



## Comments
**2026-09-10:** Superseded by FX-BF-012 and FX-BF-013 workflow implementation.


