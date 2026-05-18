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

## Manual Verification Checklist
1. Open Task Designer, add at least three tickets, drag nodes, reload VS Code, and verify positions persist.
2. Create valid connectors, then attempt a duplicate edge and a cycle; confirm both are rejected with clear feedback.
3. Verify execution ordering updates after connector changes and remains stable across repeated reloads.
4. Trigger AI recommendation preview, confirm no graph mutation until explicit apply, then verify persisted state includes applied changes.
5. Repeat once with mixed backend tickets (for example Jira + GitLab/demo) and confirm recovery keeps valid nodes/connectors when persisted payload contains stale or malformed entries.

## Known Validation Gaps / Environment Blockers
1. `npm test` currently depends on launching the VS Code host and can fail if a local VS Code update lock (`vscode-updating`) is active; rerun after the lock clears.
