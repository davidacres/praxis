# Story 04.1: Generate Master Plan From Designer Graph

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P2
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** 02.3

## Description
Generate a master plan document from the current designer graph, summarizing scope, phases, dependencies, and feature map.

## Implementation Activities
1. Add a graph-to-plan projection for top-level flow summary.
2. Create master plan markdown generation logic.
3. Write the master plan to the `plans` area.
4. Keep generation idempotent and deterministic.

## Acceptance Criteria
1. A master plan file can be generated from the current graph.
2. The file includes phases, dependencies, and feature summary.
3. Re-generating the same graph produces stable output.
4. `npm run check-types` passes.

## Verification
1. Generate the master plan twice and compare output.
2. Review dependencies and phase structure.
3. Run `npm run check-types`.
