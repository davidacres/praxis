# Story 01.3: Add Node Dragging, Deletion, And Persistence

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** 01.2

## Description
Allow ticket nodes to be dragged around the dotted surface, deleted, and restored from workspace state when the panel is reopened.

## Implementation Activities
1. Add drag interaction to nodes on the canvas.
2. Persist node positions and node metadata to workspace state.
3. Add node deletion from the canvas.
4. Restore saved nodes and positions when the panel reopens.

## Acceptance Criteria
1. Users can drag nodes and their positions persist.
2. Users can delete a node cleanly.
3. Closing and reopening the panel restores the saved canvas state.
4. `npm run check-types` passes.

## Verification
1. Drag multiple nodes and reopen the panel.
2. Delete a node and confirm it stays deleted after reopen.
3. Run `npm run check-types`.

## Dependencies



## Comments


