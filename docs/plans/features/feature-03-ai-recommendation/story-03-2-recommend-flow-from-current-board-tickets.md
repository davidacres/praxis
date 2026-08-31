# Story 03.2: Recommend Flow From Current Board Tickets

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** 03.1

## Description
Allow users to source tickets from the currently selected board and ask AI to populate and connect them into an executable flow.

## Implementation Activities
1. Add a board-sourced AI entry point in the designer.
2. Resolve the currently selected board and fetch candidate tickets.
3. Build a recommendation request from the board tickets.
4. Return a preview graph for user review.

## Acceptance Criteria
1. Users can generate a recommendation from the current board.
2. Tickets are added and connected only after explicit approval.
3. Mixed-backend board routing follows existing per-board service resolution.
4. `npm run check-types` passes.

## Verification
1. Select a board and run board-sourced AI recommendation.
2. Verify the preview contains nodes and edges.
3. Run `npm run check-types`.

## Dependencies



## Comments


