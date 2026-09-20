---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Feature
**Priority:** High
id: FX-BF-042
slug: chat-turn-telemetry-live-activity-and-reasoning-ux
title: Chat turn telemetry, live AI activity, and reasoning UX
status: Complete
owner: Electron desktop app
updated: 2026-09-20
issues: docs/issues/features/fx-bf-042-chat-turn-telemetry-live-activity-and-reasoning-ux/feature-issues.md
stories: [FX-BE-133, FX-BE-134, FX-BE-135]
validation: [npm run check-types --workspace=@praxis/core, npm run check-types --workspace=@praxis/desktop-renderer, npm run check-types --workspace=@praxis/desktop-main, npm run build --workspace=@praxis/desktop-renderer]
---

# FX-BF-042: Chat turn telemetry, live AI activity, and reasoning UX

## Outcome

Praxis Desktop provides transparent, responsive, and data-rich AI session chat
while actively protecting against LLM context bloat and cognitive UI fatigue.
Users can immediately see when an AI model is actively working (thinking or
running tools) with isolated, high-performance elapsed turn timers; reasoning
streams dynamically in a streamlined Details pane and preserves a clean,
collapsible disclosure in chat history; context window tracking is made model-aware
and reliable across all providers (including Z.ai); and every message provides
explicit temporal context (date/time), turn duration, token usage, pricing-aware
cost attribution, model badge, tool execution summaries, and one-click copy actions.

## Scope

- **Live Activity & Turn Timers:** Provide real-time chat telemetry when an AI
  turn is in progress, displaying current action status (e.g. "Thinking…",
  "Running tool: view_file…", "Generating response…") alongside a ticking turn
  timer isolated in a leaf component so the user never wonders if the session is
  frozen or hung, without triggering chat-wide re-renders.
- **Reasoning Stream Integrity & Dual-UX:** Remove the misplaced faux-assistant
  reasoning bubble from the chat stream; preserve live reasoning progression in the
  Details pane (`SessionInspector`) without arbitrary character truncation; support
  an in-chat collapsible `▸ Thought for Xs` disclosure on completed assistant
  messages; and properly clean up reasoning state across turn transitions.
- **Details Pane Streamlining & Anti-Bloat:** Reorganize the Details pane ("Summary"
  tab) to prioritize live operations (active status/timer, plan tasks checklist,
  unclipped thought stream) at the top; compact the Purpose section; and de-clutter
  the Handover Brief (hiding 7 empty fields unless handover is actively initiated).
- **Context Safeguards & Model-Aware Budget:**
  - Scale `historyBudgetChars` dynamically in `agentLoop.ts` based on model
    context length (`contextLimit * 3.5 * 0.8`) rather than a hardcoded 480k chars.
  - Implement a prompt token estimation fallback for providers (such as Z.ai) that
    omit streaming usage chunks, so the context window gauge always updates.
  - Enforce strict context protection: past `reasoningText` is never replayed in
    conversational prompt history (`compactHistoryForReplay`).
- **Message Turn Metrics & Tool Accumulation:** Extend `AgentEventSummary` with
  typed turn telemetry (duration, tokens, cost, model, tools). Accumulate tools
  executed during a turn and calculate per-turn costs via `modelPricing.ts`.
- **Chat Usability & Copy Actions:** Provide a concise tool execution pill on
  assistant messages summarizing tool runs with direct links to the Activity
  tab, plus one-click copy message action buttons on hover with visual feedback.

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-133 | Live AI activity telemetry and reasoning inspector streaming | Proposed | FX-BF-015, FX-BF-035, FX-BF-041 |
| FX-BE-134 | Per-message turn metrics, duration, token usage, and cost attribution | Proposed | FX-BE-133 |
| FX-BE-135 | Chat usability enhancements, tool execution summary, and message actions | Proposed | FX-BE-134 |

## Dependencies

- `FX-BF-015` — Session review, cost, and context presentation.
- `FX-BF-035` — Multi-AI session orchestration and provider streaming runtime.
- `FX-BF-041` — Session usage, cost, and provider allowance visibility.
- Shared `AgentSessionRecord`, `AgentEventSummary`, `modelPricing.ts`, and Vercel AI SDK adapters.

## Risks or open questions

- Live turn timers must tick efficiently using an isolated leaf component with
  local interval/rAF state so that frequent timer ticks do not trigger re-renders
  of surrounding transcript markdown nodes.
- When providers omit streaming `usage` chunks, local prompt token estimation must
  approximate token counts conservatively without understating context pressure.
- Details pane restructuring must keep the `SessionInspector` backward-compatible
  with workflow-governed runs and ACP plan updates.

## Close when

- A ticking live activity indicator is visible during active generation and tool
  runs, showing elapsed seconds and current action without chat lag.
- The misplaced `is-reasoning` chat bubble is eliminated, reasoning text
  streams continuously in the SessionInspector without a 140-character freeze,
  and completed assistant turns offer an optional collapsed reasoning disclosure.
- Details pane prioritizes live operations (timer, tasks, reasoning) and removes
  empty handover clutter.
- Context window pressure updates reliably on Z.ai models, and tool trim budget
  scales dynamically with model capacity.
- Past reasoning is verified never to leak into subsequent prompt history.
- Every chat message displays a formatted timestamp with full date tooltip.
- Assistant messages render elapsed turn duration, token usage, cost, and model badge.
- Assistant messages that executed tools display a summary pill linking to Activity.
- Message bubbles offer a hover copy button with feedback.
- All typechecks, lint/core-import checks, and production builds pass cleanly.

## Delivery order

1. Implement `FX-BE-133` (stream lifecycle cleanup, live turn indicator, inspector streamlining & disclosure).
2. Implement `FX-BE-134` (turn duration telemetry, token/cost attribution, context budget & Z.ai usage fallback).
3. Implement `FX-BE-135` (tool execution summary pill, copy button, theming/accessibility pass).

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments
