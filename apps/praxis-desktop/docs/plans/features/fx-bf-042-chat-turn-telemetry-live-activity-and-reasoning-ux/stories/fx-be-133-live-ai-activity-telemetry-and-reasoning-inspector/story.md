---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Story
**Priority:** High
type: Story
id: FX-BE-133
title: "Live AI activity telemetry and reasoning inspector streaming"
status: Complete
feature: FX-BF-042
issue: docs/issues/features/fx-bf-042-chat-turn-telemetry-live-activity-and-reasoning-ux/stories/fx-be-133-live-ai-activity-telemetry-and-reasoning-inspector/issue.md
updated: 2026-09-20
tasks: [TASK-361, TASK-362, TASK-363]
dependencies: [FX-BF-015, FX-BF-035, FX-BF-041]
validation: [npm run check-types --workspace=@praxis/core, npm run check-types --workspace=@praxis/desktop-renderer, npm run check-types --workspace=@praxis/desktop-main, npm run build --workspace=@praxis/desktop-renderer]
---

# FX-BE-133: Live AI activity telemetry and reasoning inspector streaming

## User or operational impact

Users will no longer wonder whether the AI has crashed, stalled, or lost
connection during long thinking phases or tool operations. The chat pane displays
a live, responsive activity indicator with a ticking turn timer (isolated from
chat re-renders), the Details pane is streamlined to prioritize live operations
and stream thoughts dynamically without 140-character truncation, completed
assistant messages offer a clean collapsed disclosure (`▸ Thought for Xs`), and
the confusing raw thought fragment rendered as a faux assistant chat bubble is
eliminated.

## Scope

- Remove the misplaced `is-reasoning` assistant message bubble in the main chat
  thread (`SessionsPage.tsx`).
- Ensure `record.reasoningText` in the session manager lifecycle is properly
  cleared on turn settlement and follow-up invocation.
- Add an isolated leaf component for the live chat activity indicator that ticks
  every 100ms without re-rendering parent transcript components.
- Streamline the Details pane ("Summary" tab) layout:
  - Top: Live operations (active tool status, ticking timer, plan tasks checklist,
    unclipped scrollable thought stream).
  - Middle: Compact Purpose block (goal and issue key).
  - Bottom: De-clutter Handover Brief (hide 7 empty sub-fields by default; only
    show brief when populated or when handover is explicitly triggered).
- Remove `SessionInspector`'s `truncate(text, 140)` limit so that full reasoning
  text can be inspected with proper scroll and formatting as it streams and
  remains readable after turn settlement.
- Add a collapsible disclosure (`▸ Thought for Xs`) on completed assistant
  messages when reasoning was generated during that turn.
- Ensure transitions between thinking, tool-call execution, and streaming
  message completion emit clean telemetry without dropped events.

## Acceptance criteria

- During model thinking, an activity banner appears at the bottom of the chat
  with an animated pulse and an isolated ticking elapsed timer (e.g. `✦ Thinking… 4.2s`).
- When a tool starts executing, the activity banner updates immediately to
  reflect the running tool (e.g. `✦ Running tool: view_file… 7.8s`).
- When assistant generation finishes, the live activity banner gracefully
  disappears and completed messages display `▸ Thought for Xs` if reasoning
  occurred.
- The chat thread contains only genuine user, assistant, and system messages;
  reasoning text is no longer injected into an ordinary assistant chat bubble.
- The Details pane prioritizes live operations at the top and displays the full
  reasoning content with a scrollable container instead of locking at 140 chars.
- The 7 empty handover brief sections are de-cluttered from the default view.
- Subsequent turns reset reasoning state completely so stale thought logs from
  prior turns do not persist into new prompts.

## Task list

- `TASK-361` — Remove misplaced chat reasoning bubble and fix stream lifecycle.
- `TASK-362` — Implement live chat activity indicator with elapsed turn timer and active action telemetry.
- `TASK-363` — Fix Details pane reasoning display truncation, stream layout, and anti-bloat streamlining.

## Validation

- `npm run check-types --workspace=@praxis/core`
- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run check-types --workspace=@praxis/desktop-main`
- `npm run build --workspace=@praxis/desktop-renderer`

## Close when

Live activity telemetry and turn timers are visible in the chat UI during turns,
thought streaming in the Details pane is complete and unclipped, the Details
pane is decluttered, and the misplaced reasoning bubble in chat history is
replaced by a clean disclosure.

## Description


## Dependencies


## Comments
