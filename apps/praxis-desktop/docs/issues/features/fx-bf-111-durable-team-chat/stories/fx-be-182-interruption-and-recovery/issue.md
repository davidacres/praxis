# FX-BE-182: Interruption, cancellation, and tool-outcome recovery

**Type:** Story
**Status:** To Do
**Priority:** High

Canonical plan: [FX-BE-182](../../../../../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-182-interruption-and-recovery/story.md).

## Impact and scope

Restart and retry cannot silently repeat external actions or falsely report a completed reply.

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

## Validation and close conditions

Follow the canonical story and its task-specific tests; close only when all criteria have linked evidence. No external issue has been created.
