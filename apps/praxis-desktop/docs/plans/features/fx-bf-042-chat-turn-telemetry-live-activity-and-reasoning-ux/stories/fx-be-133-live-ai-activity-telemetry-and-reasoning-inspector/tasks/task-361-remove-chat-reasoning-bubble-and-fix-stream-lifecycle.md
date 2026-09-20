---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Task
**Priority:** High
id: TASK-361
title: Remove misplaced chat reasoning bubble and fix stream lifecycle
status: Complete
story: FX-BE-133
feature: FX-BF-042
updated: 2026-09-20
---

# TASK-361: Remove misplaced chat reasoning bubble and fix stream lifecycle

## Outcome

The chat thread no longer renders raw reasoning text as a synthetic assistant
message (`is-reasoning`), preventing duplicate or truncated thought bubbles from
polluting conversational history. Session reasoning state is reset cleanly when
turns settle and when new turns initiate.

## Scope

- Remove the conditional `is-reasoning` bubble injection in
  `apps/praxis-desktop/renderer/src/ai/SessionsPage.tsx` (lines 1461-1473).
- Review and update `AgentSessionRecord.reasoningText` handling in
  `packages/core/src/ai/vercelAgentService.ts` and `sessionNav.ts` to ensure
  turn start resets previous turn thought accumulation.
- Ensure when thought streams conclude, the final assistant response retains any
  relevant reasoning metadata without polluting `message.content`.
- Add an optional collapsed `<details className="session-chat-thought-disclosure">`
  (`▸ Thought for Xs`) on the completed assistant message bubble when reasoning was
  produced during that turn.

## Acceptance criteria

- Assistant message bubbles in `SessionsPage` render only actual response content
  and optional collapsed reasoning disclosure.
- No bubble is tagged with `is-reasoning` or displays `glm-5.3-flash · Thinking…`
  with trailing slices of internal prompts/thoughts.
- When an agent turn completes, `reasoningText` does not leak into the prompt of
  the next user turn.
- Core and renderer typechecks pass without regression.

## Validation

- `npm run check-types --workspace=@praxis/core`
- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run check-types --workspace=@praxis/desktop-main`
- `npm run build --workspace=@praxis/desktop-renderer`

## Description


## Dependencies


## Comments
