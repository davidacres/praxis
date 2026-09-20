# FX-BE-133 — Live AI activity telemetry and reasoning inspector streaming

**Type:** Story
**Status:** Complete
**Priority:** High
**Depends on:** FX-BF-015, FX-BF-035, FX-BF-041

## Business or operational impact

Users gain immediate confidence that the AI is processing during long thinking or
tool invocation phases. Misplaced internal thought snippets are removed from chat
history, and full reasoning text can be inspected in the Details pane in real time.

## Scope

- Remove `is-reasoning` assistant message bubble in the chat thread.
- Reset `reasoningText` on turn start and settle.
- Add live chat activity indicator with status text and ticking elapsed turn timer.
- Remove `truncate(text, 140)` in the Details pane reasoning inspector.

## Acceptance criteria

- Sending a prompt immediately reveals a ticking activity timer in the chat.
- Status reflects whether the model is thinking, running a specific tool, or streaming.
- No synthetic thought bubble appears in the chat transcript.
- Reasoning text in `SessionInspector` streams in full without 140-char cutoff.

## Validation

- Typecheck in core, renderer, and desktop-main.
- Production build of desktop renderer.
- Manual verification of streaming and tool states.

## Close when

Live activity telemetry and turn timers function smoothly and thought streaming
in the Details pane is complete and unclipped.
