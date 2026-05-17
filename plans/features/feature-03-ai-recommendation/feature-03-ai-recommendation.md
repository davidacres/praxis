# Feature 03: AI Recommendation Flow

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Feature
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** Feature 02

## Description
Add AI assistance that can recommend a start-to-finish flow by ordering and connecting tickets, first from tickets already on the canvas and then from the current board.

## Acceptance Criteria
1. Users can request an AI recommendation for existing canvas tickets.
2. Users can preview and apply or reject the recommendation.
3. Users can optionally generate a flow from the current board tickets.
4. AI changes do not overwrite the canvas without explicit confirmation.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| 03.1 | Story | Recommend flow for existing canvas tickets | 📋 Proposed |
| 03.2 | Story | Recommend flow from current board tickets | 📋 Proposed |
| 03.3 | Story | Preview and apply AI recommendations safely | 📋 Proposed |

## Dependencies
1. Story 03.1 depends on 02.3.
2. Story 03.2 depends on 03.1.
3. Story 03.3 depends on 03.1 and 03.2.

## Verification
1. Run AI recommendation on an existing canvas.
2. Run AI recommendation from a selected board.
3. Verify accept/reject does not corrupt saved state.
