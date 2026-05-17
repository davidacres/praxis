# Task Designer Execution Master Plan

**Status:** Proposed
**Created:** 2026-05-17T00:00:00.000Z
**Type:** Master Plan
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High

## Description
Build a task designer surface that lets users add tickets to a dotted canvas, drag them into position, connect them to define execution order, and use AI to recommend a start-to-finish flow. Deliver the work in phased, functional slices so every completed story compiles, runs, and leaves the extension in a usable state.

## Goals
1. Add a standalone designer panel with a dotted canvas.
2. Support adding tickets by ticket number and rendering them as draggable nodes.
3. Support connectors that define execution order from one ticket to another.
4. Compute and validate execution order from the connector graph.
5. Add AI-assisted recommendations for ordering and connecting tickets.
6. Generate a local planning artifact structure from the designer graph.

## Non-Goals
1. Do not add runtime task execution orchestration in the first release.
2. Do not mutate Jira or GitLab dependency fields in the first release.
3. Do not add conditional branches, loops, or parallel orchestration semantics beyond a DAG-based order.

## Architecture Suggestions
1. Start with a standalone webview panel rather than a sidebar so the canvas has enough room for node and connector interactions.
2. Reuse the panel lifecycle and message routing patterns from `src/views/boardPanelManager.ts`.
3. Reuse drag-and-drop interaction patterns from `src/views/boardColumnConfigPanel.ts`.
4. Persist designer state in workspace state for the first release.
5. Treat the execution graph as a directed acyclic graph and derive order with topological sorting.
6. Stage AI recommendation in two steps: existing-canvas tickets first, current-board ticket sourcing second.

## Phase Breakdown
1. Phase 0: Create the plan artifacts and execution breakdown.
2. Phase 1: Deliver the designer shell and persisted canvas.
3. Phase 2: Deliver connectors and graph validation.
4. Phase 3: Deliver AI recommendation.
5. Phase 4: Deliver plan artifact generation from the graph.
6. Phase 5: Harden for mixed backends, persistence, and release quality.

## Feature Map
| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| 01 | Feature | Designer shell and persisted canvas | 📋 Proposed |
| 02 | Feature | Connector graph and execution order | 📋 Proposed |
| 03 | Feature | AI recommendation flow | 📋 Proposed |
| 04 | Feature | Plan artifact generation | 📋 Proposed |
| 05 | Feature | Validation and multi-backend hardening | 📋 Proposed |

## Dependencies
1. Feature 01 blocks all later implementation.
2. Feature 02 depends on Feature 01.
3. Feature 03 depends on Feature 02.
4. Feature 04 depends on Feature 02 and should land after the graph model is stable.
5. Feature 05 depends on all prior features.

## Verification
1. Every story must compile and leave the extension functional.
2. Run `npm run check-types` after each completed story.
3. Add targeted tests where the repo already has a suitable test surface.
4. Manually validate mixed Jira, GitLab, and Live Folder scenarios before release.

## Further Considerations
1. Consider an inspector panel on the right side of the designer later for node details and validation messages.
2. Consider Start and End markers only if user testing shows the DAG summary is insufficient.
3. Keep generated plan artifacts deterministic and additive so users can review changes easily.
