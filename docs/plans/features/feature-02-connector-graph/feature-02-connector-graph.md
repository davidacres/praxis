# Feature 02: Connector Graph And Execution Order

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Feature
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** Feature 01

## Description
Add directed connectors between ticket nodes, validate the graph, and compute execution order from the resulting design.

## Acceptance Criteria
1. Users can create directed connectors between nodes.
2. Users can delete connectors.
3. The system prevents cycles and duplicate edges.
4. The designer computes and displays execution order.
5. Each story compiles and remains functional when completed.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| 02.1 | Story | Create and render directed connectors | 📋 Proposed |
| 02.2 | Story | Add cycle and duplicate-edge validation | 📋 Proposed |
| 02.3 | Story | Compute and display execution order summary | 📋 Proposed |

## Dependencies
1. Story 02.1 depends on Feature 01.
2. Story 02.2 depends on 02.1.
3. Story 02.3 depends on 02.2.

## Verification
1. Create connectors across at least three nodes and verify persistence.
2. Verify invalid graph actions are blocked.
3. Run `npm run check-types` after each story.

## Comments


