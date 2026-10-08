---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-162
type: Story
status: Backlog
created: 2026-10-08
priority: High
featureId: 108
---

# Findings-routed edges and bounded loop edges

## Impact

A workflow author can say "if the review finds anything at high severity, go to Fix, then verify again, at most three times", and the engine runs exactly that and no more. Review and security findings finally reach an agent that can act on them.

## Scope

Core engine: `workflowTypes.ts`, `workflowValidation.ts` (`findCycle`, `normalizeWorkflow`), `workflowScheduler.ts`, `workflowOrchestrator.ts`, `workflowRun.ts` (`reworkWorkflowRun`, `normalizeWorkflowRun`). Two additions to the edge model:

1. **Findings edges.** Alongside `on: success | failure | always`, an edge may fire on a predicate over the source stage's `findings` (severity at or above a level, a count, a category set, a metric comparison). The counting logic already exists in `workflowGates.ts`; it is factored out and shared, not copied.
2. **Loop edges.** An edge may point backwards if it carries `loop: { maxIterations }`. Taking it calls `reworkWorkflowRun` from the target stage, resetting that stage and everything downstream, clearing stale gate decisions, and incrementing a per-edge iteration counter on the run.

## Acceptance criteria

- The validator accepts a cycle only if every edge that closes it is a loop edge with `maxIterations` between 1 and a documented ceiling. Any other cycle is still rejected with the existing message, and the message names the missing budget.
- A loop edge is taken only after the whole parallel band it follows has settled (join complete). Taking it never races an in-flight stage: it waits, and `reworkWorkflowRun`'s refusal to rework over a running downstream stage is never hit in the normal path.
- Findings predicates are evaluated against structured findings only. A source stage that produced no `findings` output cannot satisfy a findings edge, and the validator rejects a findings edge whose source declares no `findings` output.
- Iteration counters live on the run record (`loopIterations` keyed by edge id), survive restart and recovery (`workflowRecovery.ts`), and are copied by `normalizeWorkflowRun`.
- When a loop's budget is spent and its predicate still holds, the run does not fail and does not continue: the next approval-style stop opens a **needs-decision** state listing the open findings, the iteration history and three actions: approve anyway (recorded with who and why), grant more iterations (recorded), or stop the run.
- Multiple outgoing edges from one stage are evaluated in definition order; if several predicates match, the engine takes the first and records which, so behaviour is deterministic and visible. Mutating stages remain serialised (the scheduler's one-writer rule is unchanged).
- A workflow with no findings edges and no loop edges validates, schedules and runs byte-identically; the 13-test folder/edit/new-issue gate and existing workflow specs keep their counts.
- `normalizeWorkflow` and `normalizeWorkflowRun` copy every new field; a round-trip test over the shipped templates plus a new looping fixture proves nothing is dropped.
- Property-style tests: any run with loop edges terminates in at most the sum of budgets; the scheduler never dispatches a stage twice; a crash between persist and launch recovers to the same state.

## Dependencies

None for the engine. FX-BE-161 is independent. FX-BE-163, FX-BE-164, FX-BE-165, FX-BE-166 and FX-BE-167 build on this story.

## Description

Add findings-based routing and explicitly bounded back-edges so workflows can loop back to a previous step.

## Comments
