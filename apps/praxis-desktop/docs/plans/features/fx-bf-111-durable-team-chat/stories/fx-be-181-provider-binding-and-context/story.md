---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Story
**Priority:** High
id: FX-BE-181
type: Story
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
issue: docs/issues/features/fx-bf-111-durable-team-chat/stories/fx-be-181-provider-binding-and-context/issue.md
---

# FX-BE-181: Explicit provider bindings and bounded context delivery

Parent: [FX-BF-111](../../feature.md). Issue mirror: [FX-BE-181](../../../../../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-181-provider-binding-and-context/issue.md).

## User or operational impact

Each member can continue efficiently or replace a lost provider session without losing the authoritative conversation.

## Scope

- Adapt agentSessionLauncher, AiSessionManager and the existing assistant completion path behind the coordinator execution contract. Remove synthetic ticket-review framing from durable chat prompts. Resolve effective provider configuration before computing compatibility.
- Replace the assistant fixed 12-message/3000-character history path for durable chats with the context protocol below. Persist summary provenance and user-pinned decisions. Native resume receives only missing shared context, while stateless calls receive a bounded reconstructed view.

## Dependencies

FX-BE-180

## Acceptance criteria

- 480: Two turns for two compatible tool-using members create four attempts and reuse two provider sessions; another chat shares none.
- 480: A no-tools API member can complete without allocating an AgentSessionRecord; its attempt, result and reported usage remain attributable.
- 480: Changing provider/account endpoint, model, prompt version, folder, tool mode or permissions invalidates the binding; missing native resume capability uses reconstruction.
- 480: Revoked permissions cannot be recovered by selecting an old binding; current policy is revalidated before every dispatch and tool access remains behind existing gates.
- 480: Provider-reported usage is attributed once per attempt; context occupancy is never counted as cumulative spend.
- 481: Native continuation does not repeat that member's own completed reply or earlier delivered messages; other members' replies and intervening turns arrive once at the logical delivery boundary.
- 481: A fresh binding receives instructions, pinned decisions, a versioned summary, recent messages and the current turn exactly once; queued future turns are excluded.
- 481: A long fixture exceeding the former limits preserves an early pinned decision and resolves a later correction using source message IDs.
- 481: Unavailable summarization or an oversized pinned/current context causes visible context-required status rather than silent omission or an over-limit provider call.
- 481: Uncertain prompt acceptance invalidates the delivery cursor and triggers recovery; the coordinator never blindly resends into an uncertain native session.

## Tasks

- [TASK-480: Connect API and ACP execution through typed bindings](tasks/task-480-execution-adapter.md)
- [TASK-481: Build versioned context with delivery receipts and summaries](tasks/task-481-context-delivery.md)

## Validation

Use the parent feature acceptance-to-suite mapping and validation commands. Each task supplies executable scenarios; record exact commands, assertion names and artifacts. This story does not close on typechecking alone.

## Close when

Both tasks satisfy every acceptance criterion, results are linked here and in the issue mirror, and no story-specific recovery or compatibility gap remains.

## Description


## Comments
