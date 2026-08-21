# Story 03.1: Recommend Flow For Existing Canvas Tickets

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** 02.3

## Description
Use AI to analyze the tickets already on the canvas and return a recommended ordering and connector set from start to finish.

## Implementation Activities
1. Collect canvas ticket metadata for prompting.
2. Reuse existing AI workflow patterns for prompt, execution, and parsing.
3. Ask AI for ordered nodes and directed edges.
4. Return the result as a preview model rather than applying it immediately.

## Acceptance Criteria
1. AI can recommend a graph for tickets already on the canvas.
2. The recommendation includes order and connector proposals.
3. The panel remains stable if AI output is invalid or partial.
4. `npm run check-types` passes.

## Verification
1. Run AI on a canvas with multiple tickets.
2. Verify the preview data is populated.
3. Run `npm run check-types`.
