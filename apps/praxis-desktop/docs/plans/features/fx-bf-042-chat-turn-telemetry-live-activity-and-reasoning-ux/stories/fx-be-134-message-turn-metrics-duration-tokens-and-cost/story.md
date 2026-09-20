---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Story
**Priority:** High
type: Story
id: FX-BE-134
title: "Per-message turn metrics, duration, token usage, and cost attribution"
status: Complete
feature: FX-BF-042
issue: docs/issues/features/fx-bf-042-chat-turn-telemetry-live-activity-and-reasoning-ux/stories/fx-be-134-message-turn-metrics-duration-tokens-and-cost/issue.md
updated: 2026-09-20
tasks: [TASK-364, TASK-365, TASK-366]
dependencies: [FX-BE-133]
validation: [npm run check-types --workspace=@praxis/core, npm run check-types --workspace=@praxis/desktop-renderer, npm run check-types --workspace=@praxis/desktop-main, npm run build --workspace=@praxis/desktop-renderer]
---

# FX-BE-134: Per-message turn metrics, duration, token usage, and cost attribution

## User or operational impact

Developers chatting with agents in Praxis need clear insight into how long
individual queries took, how many tokens were consumed, what each turn cost, and
which model responded. Instead of having to inspect global session usage modals,
every message bubble displays fine-grained temporal context and turn metrics directly
in the conversational flow, backed by model pricing tables across all providers.
Context window metrics update accurately across all providers (including Z.ai),
and tool history budgets scale dynamically without context overflows or premature
drops.

## Scope

- Extend `AgentEventSummary` in `packages/core/src/ai/agentTypes.ts` with typed
  turn telemetry (`durationMs`, `tokenUsage`, `cost`, `modelId`, `toolNames`).
- Capture start time and finish time of agent turns in the runtime execution
  pipeline (`vercelAgentService.ts` and agent loop).
- Calculate turn token consumption and estimated cost using `modelPricing.ts`
  and `estimateUsageCost` across all supported API providers.
- Implement a local prompt token estimation fallback for providers (such as Z.ai)
  that omit the streaming usage chunk, ensuring `contextTokens` updates and context
  pressure displays accurately.
- Scale `historyBudgetChars` dynamically in `agentLoop.ts` based on model context
  capacity (`contextLimit * 3.5 * 0.8`) rather than a hardcoded 480k constant.
- Enforce strict context protection: past `reasoningText` is excluded from
  `compactHistoryForReplay` so prior thoughts never inflate follow-up turns.
- Render timestamps (formatted local time with full ISO date tooltip on hover)
  on all messages (user and assistant).
- Render a compact metrics footer on assistant messages with duration (`e.g. 3.2s`),
  token breakdown (`e.g. 1,420 tokens`), estimated cost (`e.g. $0.0018`), and
  model identity badge (`e.g. glm-5.3-flash`).

## Acceptance criteria

- Every user and assistant message displays a discreet, styled timestamp.
- Completed assistant turns show the exact elapsed time taken for the turn.
- Token usage (input / output / reasoning) and computed turn cost are displayed in
  an unobtrusive chip cluster on assistant messages when available.
- Context window pressure updates reliably for Z.ai models via local estimation
  when streaming usage chunks are missing.
- Model tool history budget scales appropriately from small (8k) to massive (2M)
  model contexts.
- The model badge indicates which provider model generated the response (vital
  for multi-AI conversations and mid-session model switches).
- Data persists across session reloads from stored session events.

## Task list

- `TASK-364` — Define turn duration and message-level token/cost telemetry contracts in core.
- `TASK-365` — Capture and thread turn duration, token usage, cost, model attribution, and dynamic context budget through session runtime.
- `TASK-366` — Render message timestamp, duration, token/cost chips, and model attribution in chat UI.

## Validation

- `npm run check-types --workspace=@praxis/core`
- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run check-types --workspace=@praxis/desktop-main`
- `npm run build --workspace=@praxis/desktop-renderer`

## Close when

Timestamps, duration, tokens, cost, and model attribution are captured on turns,
Z.ai context tracking is verified working, and dynamic context budgets scale safely.

## Description


## Dependencies


## Comments
