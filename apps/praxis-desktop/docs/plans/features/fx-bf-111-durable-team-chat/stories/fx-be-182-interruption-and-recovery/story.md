---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Story
**Priority:** High
id: FX-BE-182
type: Story
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
issue: docs/issues/features/fx-bf-111-durable-team-chat/stories/fx-be-182-interruption-and-recovery/issue.md
---

# FX-BE-182: Interruption, cancellation, and tool-outcome recovery

Parent: [FX-BF-111](../../feature.md). Issue mirror: [FX-BE-182](../../../../../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-182-interruption-and-recovery/issue.md).

## User or operational impact

Restart and retry cannot silently repeat external actions or falsely report a completed reply.

## Scope

- Persist dispatch intent before provider invocation, fence callbacks by coordinator epoch and attempt ID, and reconcile runtime evidence on startup. Correlate tool activity where observable and treat opaque tool-capable runtimes conservatively.
- Wire coordinator operations to existing runtime abort and permission APIs. Record user recovery decisions; retain partial output as attempt evidence. Reconnect approvals by stable runtime request identity or mark them interrupted.

## Dependencies

FX-BE-181

## Acceptance criteria

- 482: Crash injection before dispatch, after dispatch, after tool success and before reply commit produces the recovery states specified in the feature matrix.
- 482: A provider result durably available for the same attempt is imported once; an unresolved tool-capable attempt becomes outcome_unknown and blocks later work.
- 482: Restart never automatically re-executes an uncertain attempt; a read-only reconciliation result or explicit informed user resolution is required.
- 482: Late duplicate completion and tool events cannot append a second reply, restart a cancelled turn or release another attempt's resource claim.
- 483: Cancel retains completed member replies, marks remaining members skipped and cancels queued turns in that conversation; a running tool remains cancelling until termination or outcome_unknown is established.
- 483: Retry targets only the failed/interrupted member, appends a new attempt and preserves completed predecessors; successors resume once the retry commits.
- 483: Restart invalidates unresolved approval callbacks; approval is requested again only after verifying a live matching runtime request, never transferred to a new attempt.
- 483: A user-authorized retry after outcome_unknown records duplicate-action risk acknowledgement and the reconciliation evidence; it cannot be mistaken for a safe automatic retry.

## Tasks

- [TASK-482: Reconcile interrupted attempts and uncertain tool outcomes](tasks/task-482-recovery-reconciliation.md)
- [TASK-483: Implement safe cancellation, retry, and approval restoration](tasks/task-483-cancel-retry-permissions.md)

## Validation

Use the parent feature acceptance-to-suite mapping and validation commands. Each task supplies executable scenarios; record exact commands, assertion names and artifacts. This story does not close on typechecking alone.

## Close when

Both tasks satisfy every acceptance criterion, results are linked here and in the issue mirror, and no story-specific recovery or compatibility gap remains.

## Description


## Comments
