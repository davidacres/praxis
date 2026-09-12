# Story 02.1: Create And Render Directed Connectors

**Status:** Obsolete
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** 01.3

## Description
Allow users to create directed connections from one ticket node to another and render those connections on the dotted surface.

## Implementation Activities
1. Extend the persisted designer model with edge records.
2. Add UI interactions for selecting a source node and connecting it to a target node.
3. Render connector lines or arrows on the surface.
4. Persist edges alongside nodes.

## Acceptance Criteria
1. Users can connect one node to another.
2. Connector direction is visible.
3. Reopening the panel restores connectors.
4. `npm run check-types` passes.

## Verification
1. Connect at least two nodes and reopen the panel.
2. Confirm connector rendering and direction.
3. Run `npm run check-types`.

## Dependencies



## Comments
**2026-09-10:** Superseded by FX-BF-012 and FX-BF-013 workflow implementation.


