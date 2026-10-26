# FX-BE-180: Main-owned turn scheduling and command delivery

**Type:** Story
**Status:** To Do
**Priority:** High

Canonical plan: [FX-BE-180](../../../../../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-180-main-owned-coordinator/story.md).

## Impact and scope

Chat work continues after its window closes, with deterministic ordering and no duplicate turns.

## Dependencies

FX-BE-179

## Acceptance criteria

- 478: Two simultaneous sends produce distinct FIFO queued turns, while repeated delivery of one command produces one turn.
- 478: Selected members answer in dev, qa, security, product, lead order; an explicit mention selects only that member; an empty roster resolves to lead.
- 478: Later members see earlier committed replies from their turn; no member sees queued future user messages.
- 478: Changing roster or runtime defaults affects subsequent accepted turns only; failures pause the current turn and leave later turns queued.
- 479: An IPC timeout after durable acceptance followed by resubmission of the same command ID returns the original turn ID.
- 479: A new window loads a snapshot and applies newer revisions; duplicate events are ignored and a revision gap triggers a fresh snapshot without replaying work.
- 479: Invalid participant, project, attachment reference, permission choice and stale retry target are rejected before provider invocation.
- 479: Closing the initiating renderer does not cancel accepted work; another window can observe the same turn and pending approval.

## Validation and close conditions

Follow the canonical story and its task-specific tests; close only when all criteria have linked evidence. No external issue has been created.
