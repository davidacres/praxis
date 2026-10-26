# FX-BE-181: Explicit provider bindings and bounded context delivery

**Type:** Story
**Status:** To Do
**Priority:** High

Canonical plan: [FX-BE-181](../../../../../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-181-provider-binding-and-context/story.md).

## Impact and scope

Each member can continue efficiently or replace a lost provider session without losing the authoritative conversation.

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

## Validation and close conditions

Follow the canonical story and its task-specific tests; close only when all criteria have linked evidence. No external issue has been created.
