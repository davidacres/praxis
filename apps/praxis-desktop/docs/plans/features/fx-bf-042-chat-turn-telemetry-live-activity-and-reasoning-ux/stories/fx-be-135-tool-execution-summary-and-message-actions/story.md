---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-135
title: "Chat usability enhancements, tool execution summary, and message actions"
status: Complete
feature: FX-BF-042
issue: docs/issues/features/fx-bf-042-chat-turn-telemetry-live-activity-and-reasoning-ux/stories/fx-be-135-tool-execution-summary-and-message-actions/issue.md
updated: 2026-09-20
tasks: [TASK-367, TASK-368, TASK-369]
dependencies: [FX-BE-134]
validation: [npm run check-types --workspace=@praxis/core, npm run check-types --workspace=@praxis/desktop-renderer, npm run check-types --workspace=@praxis/desktop-main, npm run build --workspace=@praxis/desktop-renderer]
---

# FX-BE-135: Chat usability enhancements, tool execution summary, and message actions

## User or operational impact

During complex turns involving tool usage (e.g. file reading, edits, searches),
the conversation thread can feel disconnected from the actions taken by the AI.
By providing a concise tool execution summary pill directly inside the assistant
message, users can immediately see which tools ran and jump to detailed logs in
the Activity tab with one click. Additionally, hover-accessible one-click copy
buttons for chat messages streamline sharing and referencing model responses.

## Scope

- Render a tool execution pill on assistant messages that executed tools (e.g.
  `🛠️ Ran 3 tools (view_file, replace_file_content) · View in Activity`).
- Clicking "View in Activity" navigates the session right inspector directly to
  the Activity tab with the corresponding tool event highlighted or scrolled into
  view.
- Add an accessible one-click copy button on hover for message bubbles, with
  visual confirmation ("Copied!").
- Perform full theme verification across all surface packs (flat, parchment,
  graphite, etc.) and ensure focus states adhere to Praxis accessibility rules.

## Acceptance criteria

- Assistant turns that invoked tools display an interactive summary pill in the
  message card.
- Clicking the pill switches the right inspector tab to "Activity".
- Hovering any message card reveals a copy button; clicking it copies the raw
  message markdown to clipboard and provides feedback.
- Copy button is fully accessible via keyboard (`tab`, `enter`/`space`).
- All styling inherits Praxis theme tokens without hardcoded colors or bare
  outline resets.

## Task list

- `TASK-367` — Add tool execution summary chip to assistant messages with activity tab navigation.
- `TASK-368` — Add one-click copy message button with clipboard feedback.
- `TASK-369` — Verification, theming compatibility across surface packs, and accessibility/keyboard focus testing.

## Validation

- `npm run check-types --workspace=@praxis/core`
- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run check-types --workspace=@praxis/desktop-main`
- `npm run build --workspace=@praxis/desktop-renderer`

## Close when

Tool execution pills link seamlessly to the Activity tab, copy buttons work with
accessible feedback, and visual styling passes across all themes.

## Description


## Dependencies


## Comments
