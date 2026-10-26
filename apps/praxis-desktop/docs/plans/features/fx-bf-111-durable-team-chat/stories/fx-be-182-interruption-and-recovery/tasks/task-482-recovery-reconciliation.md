---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-482
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-182
---

# TASK-482: Reconcile interrupted attempts and uncertain tool outcomes

Parent: [FX-BE-182](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Persist dispatch intent before provider invocation, fence callbacks by coordinator epoch and attempt ID, and reconcile runtime evidence on startup. Correlate tool activity where observable and treat opaque tool-capable runtimes conservatively.

## Dependencies

TASK-481

## Acceptance criteria

- Crash injection before dispatch, after dispatch, after tool success and before reply commit produces the recovery states specified in the feature matrix.
- A provider result durably available for the same attempt is imported once; an unresolved tool-capable attempt becomes outcome_unknown and blocks later work.
- Restart never automatically re-executes an uncertain attempt; a read-only reconciliation result or explicit informed user resolution is required.
- Late duplicate completion and tool events cannot append a second reply, restart a cancelled turn or release another attempt's resource claim.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments
