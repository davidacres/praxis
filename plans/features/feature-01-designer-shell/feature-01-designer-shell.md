# Feature 01: Designer Shell And Persisted Canvas

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Feature
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** None

## Description
Create the first functional version of the task designer as a standalone panel with a dotted design surface, toolbar actions, persisted canvas state, and draggable ticket nodes created from ticket numbers.

## Acceptance Criteria
1. Users can open the task designer from a command.
2. The panel renders a dotted design surface and toolbar.
3. Users can add a ticket by entering the ticket number.
4. Added tickets render as draggable nodes on the canvas.
5. Canvas state persists across panel close and reopen.
6. The extension compiles and remains functional after each story in this feature.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| 01.1 | Story | Create standalone designer panel shell | 📋 Proposed |
| 01.2 | Story | Add ticket lookup and node creation | 📋 Proposed |
| 01.3 | Story | Add node dragging, deletion, and persistence | 📋 Proposed |

## Dependencies
1. Story 01.1 must land before 01.2.
2. Story 01.2 must land before 01.3.

## Verification
1. Open the designer panel and verify the dotted surface renders.
2. Add at least one ticket node and verify it survives a panel reopen.
3. Run `npm run check-types` after each story.
