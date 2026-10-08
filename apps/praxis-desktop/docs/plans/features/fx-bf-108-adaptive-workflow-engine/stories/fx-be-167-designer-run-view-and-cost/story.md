---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Story
**Priority:** Medium
id: FX-BE-167
type: Story
status: Done
created: 2026-10-08
priority: Medium
featureId: 108
---

# Designer, run view and cost visibility for loops

## Impact

Authors can draw, understand and bound a loop in the designer, watchers can see which iteration a run is on and why, and nobody starts a large run without knowing roughly what it will cost.

## Scope

`apps/praxis-desktop/renderer/src/workflows` (designer, `WorkflowPipelineVertical`, `WorkflowRunPage`, `StartRunDialog`), `workflowDesignerState.ts`, a core estimator. Follow `renderer/AGENTS.md` and `workflows/AGENTS.md`; use existing form primitives and tokens; no new CSS token.

## Acceptance criteria

- The designer can create and edit findings edges (predicate editor: severity, count, category, metric) and loop edges (iteration budget), draws back-edges distinctly, and shows validation errors (missing budget, findings edge from a stage with no findings output) next to the edge.
- A `map` node and `independentOf` are editable in the stage inspector.
- The run view shows the current iteration per loop ("Fix: iteration 2 of 3"), the predicate that fired and the findings that triggered it, and a per-iteration history with scores when present. Step buttons keep the `Name (type): lane` aria-label the specs select by.
- A needs-decision state (FX-BE-162) is a clear call to action in the run panel and the sidebar run node with approve-anyway, grant-more and stop.
- The start-run dialog shows a projected worst case before launch: maximum stage launches (sum of loop budgets and map caps), the models and tiers they will use, and, where per-model usage data exists, a token/spend range, labelled as an estimate. A run whose worst case exceeds a configurable threshold needs an explicit confirm.
- Estimates never present invented figures: where there is no data the dialog says "not estimable", consistent with the provider budget panel's rule.
- E2E specs cover creating a loop in the designer, saving and reloading it (proving fields are not dropped), watching a looping run, and the needs-decision path. Snapshots are updated deliberately with the actual images read, and screenshots of the designer and run view are inspected in light and dark.

## Delivered

Designer: loop edges drawn under the stages with a budget badge (also a click target), an edge drawn back into its source's past becomes a bounded loop, the connection inspector edits the findings predicate and the loop budget/keep-best, validation issues shown on the connection, and agent stages set independence, refutes and the test guard; **For each** stages from the palette. Run view: the pass a stage is on, each loop's history and scores, a needs-decision notice, the sidebar row's needs-decision state. Start dialog: the workflow's parameters and the worst-case estimate (`workflowEstimate.ts`), tokens/spend only from measured stage sessions, and a confirm above `delivery.runConfirmAgentSessions` (Settings › Delivery, default 40).

Verified by `workflowLoops.spec.ts` (designer save/reload round-trip — proven to fail when `normalizeWorkflow` drops `loop` — a looping run to a recorded decision, start-dialog parameters and estimate, dark mode), `workflowEstimate.test.ts`, `workflowDesignerState.test.ts`, and screenshots of the designer, inspector, decision, loop history and start dialog inspected in light and dark. Baselines updated after inspection: `workflow-run-panel` (adds the Loops section) and `workflow-designer-open` (new layout and loop edges).

## Dependencies

FX-BE-162
FX-BE-165
FX-BE-166

## Description

Surface the loop capability in the designer and run view and show projected cost before launch.

## Comments
