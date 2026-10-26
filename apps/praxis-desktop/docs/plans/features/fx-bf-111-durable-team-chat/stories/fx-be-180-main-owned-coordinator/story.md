---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Story
**Priority:** High
id: FX-BE-180
type: Story
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
issue: docs/issues/features/fx-bf-111-durable-team-chat/stories/fx-be-180-main-owned-coordinator/issue.md
---

# FX-BE-180: Main-owned turn scheduling and command delivery

Parent: [FX-BF-111](../../feature.md). Issue mirror: [FX-BE-180](../../../../../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-180-main-owned-coordinator/issue.md).

## User or operational impact

Chat work continues after its window closes, with deterministic ordering and no duplicate turns.

## Scope

- Create a core TeamChatCoordinator hosted by a main singleton. Inject repository, execution adapter, clock and ID source. Resolve mentions and roster in main; commit the response plan before dispatch. Enforce one active turn per conversation.
- Replace renderer-owned turn/save sequencing with submitTurn, getConversation, listChats, subscribe, cancelTurn, retryParticipant and resolveAttempt commands through AssistantIpc/preload. Keep CRUD routed through the same repository; reject legacy whole-transcript saves for migrated chats.

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

## Tasks

- [TASK-478: Implement the durable sequential turn coordinator](tasks/task-478-turn-coordinator.md)
- [TASK-479: Expose validated commands and revisioned conversation updates](tasks/task-479-command-and-event-ipc.md)

## Validation

Use the parent feature acceptance-to-suite mapping and validation commands. Each task supplies executable scenarios; record exact commands, assertion names and artifacts. This story does not close on typechecking alone.

## Close when

Both tasks satisfy every acceptance criterion, results are linked here and in the issue mirror, and no story-specific recovery or compatibility gap remains.

## Description


## Comments
