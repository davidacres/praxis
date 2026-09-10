# Story 01.1: Create Standalone Designer Panel Shell

**Status:** Obsolete
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** None

## Description
Add a new standalone task designer panel, command entry point, synchronous webview initialization, and a dotted empty canvas with basic toolbar actions.

## Implementation Activities
1. Add a new panel manager under `src/views/` using the existing standalone panel pattern.
2. Register a `praxis.openTaskDesigner` command in activation/command wiring.
3. Render a dotted empty surface with toolbar actions for Add Ticket and AI Recommend.
4. Add an empty-state message and a lightweight persisted state model with no nodes yet.

## Acceptance Criteria
1. Running the command opens the panel.
2. The panel renders reliably in VS Code Insiders by setting HTML synchronously after creation.
3. The designer surface is visibly dotted and empty by default.
4. `npm run check-types` passes.

## Verification
1. Launch the command and verify the panel opens without a blank screen.
2. Verify the toolbar buttons render.
3. Run `npm run check-types`.

## Dependencies



## Comments
**2026-09-10:** Superseded by FX-BF-012 (Governed delivery workflows) and FX-BF-014 (Workflow experience). Visual designer functionality now part of completed workflow implementation.


