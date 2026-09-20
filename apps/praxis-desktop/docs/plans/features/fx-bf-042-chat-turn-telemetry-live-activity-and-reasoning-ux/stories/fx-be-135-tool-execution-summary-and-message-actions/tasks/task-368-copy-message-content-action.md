---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-368
title: Add one-click copy message button with clipboard feedback
status: Complete
story: FX-BE-135
feature: FX-BF-042
updated: 2026-09-20
---

# TASK-368: Add one-click copy message button with clipboard feedback

## Outcome

Users can effortlessly copy any message text from the chat thread to their
system clipboard with a single click on a subtle hover action button, receiving
clear visual confirmation that the text was copied.

## Scope

- Add an action button in the message bubble header/corner that appears on hover
  or when focused via keyboard.
- Implement clipboard write using `navigator.clipboard.writeText` with graceful
  error handling.
- Provide temporary visual feedback (e.g. icon transforms to checkmark, "Copied!"
  tooltip for 2 seconds).
- Ensure button uses themed Praxis icon button styles.

## Acceptance criteria

- Copy button appears on hover for both user and assistant messages.
- Clicking the button copies the raw markdown/text to the clipboard.
- The button confirms copy success visually with a checkmark or toast tooltip.
- Accessible via keyboard navigation (`tab` into the message card).

## Validation

- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run build --workspace=@praxis/desktop-renderer`

## Description


## Dependencies


## Comments
