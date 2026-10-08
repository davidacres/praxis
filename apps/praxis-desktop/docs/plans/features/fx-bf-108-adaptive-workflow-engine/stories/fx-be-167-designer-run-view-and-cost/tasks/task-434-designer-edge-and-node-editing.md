---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-434
slug: designer-edge-and-node-editing
title: Designer: findings edges, loop edges, map node and independentOf
status: Backlog
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 167
---

# TASK-434: Designer: findings edges, loop edges, map node and independentOf

## Description

Add editing of findings predicates, loop budgets, the map node and `independentOf` to the designer, with back-edges drawn distinctly and validation shown beside the offending edge.

## Acceptance criteria

- A loop saved and reloaded keeps every new field (e2e save/reload round-trip, the failure mode `modelTier` first hit).
- Predicate editor uses existing controls and tokens; no new component or CSS token.
- Validation messages from the core validator appear unchanged in the designer.
- `workflowDesignerState.ts` tests cover adding, editing and removing each new element.
- Screenshots of the designer in light and dark are captured and inspected; snapshots are updated deliberately.

## Dependencies

- TASK-422
- TASK-427
- TASK-429

## Comments
