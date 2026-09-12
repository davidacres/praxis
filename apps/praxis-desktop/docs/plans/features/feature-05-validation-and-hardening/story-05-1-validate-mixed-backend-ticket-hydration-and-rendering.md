# Story 05.1: Validate Mixed-Backend Ticket Hydration And Rendering

**Status:** Obsolete
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** 03.2

## Description
Verify that the designer correctly resolves and renders tickets from Jira, GitLab, Live Folder, and mixed board scenarios without using the wrong backend.

## Implementation Activities
1. Audit ticket and board service resolution paths used by the designer.
2. Add mixed-backend validation cases.
3. Ensure node rendering does not rely on the currently active backend only.
4. Fix cross-backend regressions uncovered during testing.

## Acceptance Criteria
1. Mixed-backend designer nodes render correctly.
2. Backend-specific errors do not leak into unrelated items.
3. `npm run check-types` passes.

## Verification
1. Add Jira, GitLab, and Live Folder tickets to the designer.
2. Exercise board-sourced recommendation on mixed contexts.
3. Run `npm run check-types`.

## Dependencies



## Comments
**2026-09-10:** Validation work now part of individual feature delivery across FX-BF series.


