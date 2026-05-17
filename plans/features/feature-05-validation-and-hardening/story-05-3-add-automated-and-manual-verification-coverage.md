# Story 05.3: Add Automated And Manual Verification Coverage

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** 05.1, 05.2

## Description
Add targeted automated coverage and a manual verification checklist for the designer's core user flows.

## Implementation Activities
1. Add narrow unit or integration coverage where the current test harness fits.
2. Add manual verification steps for drag, connectors, ordering, AI preview, and persistence.
3. Document any known environment blockers, such as test-host launch issues.
4. Ensure the final checklist covers all supported backends.

## Acceptance Criteria
1. Core designer flows have automated coverage where practical.
2. Manual verification instructions are complete.
3. Known validation gaps are documented.
4. `npm run check-types` passes.

## Verification
1. Run the available targeted checks.
2. Execute the manual checklist.
3. Run `npm run check-types`.
