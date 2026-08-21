# Story 03.3: Preview And Apply AI Recommendations Safely

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** 03.1, 03.2

## Description
Add a review/apply flow that lets users inspect AI recommendations, accept them, reject them, or replace only specific parts of the canvas.

## Implementation Activities
1. Add a recommendation preview state in the panel.
2. Show added nodes, moved nodes, and proposed connectors before apply.
3. Add Accept and Reject actions.
4. Ensure persistence only happens after explicit acceptance.

## Acceptance Criteria
1. Users can inspect AI recommendations before they are applied.
2. Rejecting a recommendation leaves the saved graph unchanged.
3. Accepting a recommendation persists the new graph safely.
4. `npm run check-types` passes.

## Verification
1. Run an AI recommendation and reject it.
2. Run another recommendation and accept it.
3. Run `npm run check-types`.
