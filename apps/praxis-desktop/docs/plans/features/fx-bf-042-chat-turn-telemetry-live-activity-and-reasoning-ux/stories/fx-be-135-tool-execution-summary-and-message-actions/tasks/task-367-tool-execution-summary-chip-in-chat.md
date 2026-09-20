---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-367
title: Add tool execution summary chip to assistant messages with activity tab navigation
status: Complete
story: FX-BE-135
feature: FX-BF-042
updated: 2026-09-20
---

# TASK-367: Add tool execution summary chip to assistant messages with activity tab navigation

## Outcome

Assistant messages that executed tools during their turn display a concise,
informative tool execution pill (e.g. `🛠️ Ran 2 tools (view_file, replace_file_content) · View in Activity`).
Clicking the action navigates the inspector pane to the Activity tab.

## Scope

- Associate tool call events in `session.events` with their generating assistant turn.
- Render a summary chip at the top or bottom of the message content displaying
  tool names and total count.
- Wire click handler to switch the `SessionInspector` active tab to `'activity'`.
- Format gracefully when many tools are called (e.g. `Ran 8 tools (view_file, +3 more)`).

## Acceptance criteria

- If no tools were called in the turn, no pill is shown.
- If tools were called, the pill clearly lists the distinct tools and total count.
- Clicking the pill switches the inspector to the Activity tab.
- Hover and focus states match the Praxis design system.

## Validation

- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run build --workspace=@praxis/desktop-renderer`

## Description


## Dependencies


## Comments
