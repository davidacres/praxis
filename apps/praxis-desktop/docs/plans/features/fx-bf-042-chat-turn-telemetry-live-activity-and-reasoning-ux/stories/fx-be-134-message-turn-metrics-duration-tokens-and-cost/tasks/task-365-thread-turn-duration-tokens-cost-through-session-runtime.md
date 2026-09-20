---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Task
**Priority:** High
id: TASK-365
title: Capture and thread turn duration, token usage, cost, model attribution, and dynamic context budget through session runtime
status: Complete
story: FX-BE-134
feature: FX-BF-042
updated: 2026-09-20
---

# TASK-365: Capture and thread turn duration, token usage, cost, model attribution, and dynamic context budget through session runtime

## Outcome

The AI runtime accurately times each model turn from initial dispatch to stream
settlement, accumulates all tools executed during the turn, extracts or estimates
token usage from provider completions, computes per-turn costs via `modelPricing.ts`,
attributes the executing model id, scales tool history budgets dynamically to
prevent context overflows, and records this telemetry onto the saved `message` event.

## Scope

- In `packages/core/src/ai/vercelAgentService.ts`:
  - Mark `task.turnStartTime = Date.now()` and initialize `task.turnTools = []`.
  - Pass dynamic `historyBudgetChars = Math.floor((record.contextLimit ?? 128000) * 3.5 * 0.8)`
    to `runAgentLoop` so that tool output trimming respects the model's actual
    context size (from 8k up to 2M).
  - Ensure `compactHistoryForReplay` strips any `reasoningText` from prior turns
    so thought logs never bloat follow-up conversational prompts.
- On tool start events during the loop, append `event.name` to `task.turnTools`.
- On turn completion (`completed` / `message`):
  - Compute `durationMs = Date.now() - task.turnStartTime`.
  - Extract turn `tokenUsage` from the completion event. If `usage` is missing
    from the provider stream (e.g. Z.ai PaaS endpoint), compute prompt token
    estimates from sent payload characters (`Math.ceil(chars / 3.5)`) and record
    to `record.contextTokens` so context gauges update reliably.
  - Compute estimated turn cost using `estimateUsageCost` from `modelPricing.ts`
    for API providers (and respect reported costs for ACP agents).
  - Attach `durationMs`, `tokenUsage`, `cost`, `modelId`, and `toolNames` to the
    emitted assistant `message` event.
- Finalize duration cleanly on abort or error states.

## Acceptance criteria

- Completed assistant message events contain exact execution duration in ms.
- Token metrics match the usage reported by the provider stream, with a safe
  fallback for Z.ai that updates `contextTokens`.
- Turn cost is computed deterministically according to active provider/model rates.
- Tools called during multi-step turns are accumulated in `toolNames`.
- The tool trimming budget in `agentLoop.ts` scales to the model's context length.
- Prior reasoning text is proven never to leak into subsequent prompt history.
- Telemetry is saved durably in session events.

## Validation

- `npm run check-types --workspace=@praxis/core`
- `npm run check-types --workspace=@praxis/desktop-main`
- Unit tests verifying duration, tool accumulation, token extraction/fallback, and cost calculation.

## Description


## Dependencies


## Comments
