# FX-BE-134 — Per-message turn metrics, duration, token usage, and cost attribution

**Type:** Story
**Status:** Complete
**Priority:** High
**Depends on:** FX-BE-133

## Business or operational impact

Provides conversational observability: users can review exact duration, token
consumption, turn cost, and model attribution directly on each message bubble
without digging into logs or separate spend screens.

## Scope

- Add message-level telemetry schema (`timestamp`, `durationMs`, `tokenUsage`, `cost`, `modelId`).
- Time agent turns in `vercelAgentService.ts` and compute token usage and costs.
- Display message timestamps and metrics chip cluster on assistant messages.

## Acceptance criteria

- All messages render formatted time.
- Completed assistant turns show duration (`e.g. 3.2s`), tokens, cost (`e.g. $0.0014`),
  and model badge (`e.g. glm-5.3-flash`).
- Telemetry persists across session reloads.

## Validation

- Workspace typechecks (`core`, `renderer`, `main`).
- Unit tests for cost calculation and telemetry serialization.
- Renderer production build.

## Close when

Per-message metrics and timestamps render cleanly on assistant and user messages.
