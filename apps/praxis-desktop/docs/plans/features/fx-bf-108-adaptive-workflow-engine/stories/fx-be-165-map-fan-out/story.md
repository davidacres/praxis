---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Story
**Priority:** Medium
id: FX-BE-165
type: Story
status: Done
created: 2026-10-08
priority: Medium
featureId: 108
---

# Map node: parallel fan-out with isolated worktrees

## Impact

A workflow can say "for each of these findings (or files, or modules), run this stage in parallel and gather the results". Today the graph is static, so it cannot fan out over a list that is only known at run time, and the scheduler allows one writer at a time.

## Scope

New `map` node kind (types, validation, scheduler, orchestrator, designer), `workflowWorkspace.ts` / `workflowMergeRunner.ts` (per-item worktrees and merge-back), `workflowAgentStage.ts`. Builds on the loop engine and on FX-BF-048's resource coordination for shared resources such as the live app.

## Acceptance criteria

- A `map` node takes a list input (a findings output, a plan's items, or a file-glob result), a child stage template, a concurrency cap and a hard item cap. Items beyond the cap are not silently dropped: the run records how many were deferred and stops for a decision.
- Read-only children share the run's worktree and run in parallel. Mutating children each get their own worktree and branch off the same snapshot; the one-writer rule is unchanged for the shared worktree.
- Results are merged back in a deterministic order by `runMerge`; a conflict fails only the affected item, is reported with both sides, and can be retried or handed to a resolver stage.
- Per-item outcomes, findings and sessions are recorded on the run and aggregate into one output (`findings` concatenated and deduplicated by fingerprint, `diff` as the merged snapshot).
- A partial failure policy is explicit on the node (`failFast` or `collect`), defaulting to `collect`; the join after a map settles only when every item has settled or been stopped.
- Concurrency is bounded by the node cap and a global app cap so a large fan-out cannot exhaust the machine or provider limits; provider-limit pauses apply per item and never spend an item's attempt.
- Cancellation stops every in-flight child and releases its worktree, keeping branches and preserving uncommitted work as `removeDeliveryWorktree` already does.
- Existing runs and templates are untouched; a workflow with no map node is unaffected.

## Delivered

`WorkflowMapNode` (`over`, `itemSource`, `concurrency` ≤ 8, `maxItems` ≤ 50, `onItemFailure`); `workflowMap.ts` derives items, plans the next attempt (items past the cap deferred and recorded; a retry runs only what has not succeeded), writes each item's brief and folds results. `workflowMapRunner.ts` runs items under a per-node and a global cap, each writing item in its own worktree on a `wfitem-…` branch (`mapWorktrees.ts`), merged back in item order with conflicts backed out and named; an item stopped by a provider limit pauses the map.

Verified by `workflowMap.test.ts` (validation, items, cap and retry, aggregation, orchestrator dispatch, provider-limit pause) and `mapWorktrees.test.ts` (a real repository: three items, one conflicting).

## Dependencies

FX-BE-162

## Description

Add a map node for parallel, isolated fan-out over run-time lists.

## Comments
