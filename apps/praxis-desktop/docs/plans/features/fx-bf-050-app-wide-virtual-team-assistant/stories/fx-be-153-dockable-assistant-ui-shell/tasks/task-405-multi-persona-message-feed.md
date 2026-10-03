---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-405
type: Task
status: Backlog
created: 2026-10-03
priority: High
---

# Multi-persona message feed component with role badges and interactive choice cards

## Files and integration points

- `apps/praxis-desktop/renderer/src/assistant/AssistantMessageFeed.tsx` (new): Renders the scrollable message stream.
- `apps/praxis-desktop/renderer/src/assistant/AssistantMessageCard.tsx` (new): Renders individual turns with persona identity, badge, Markdown text, and interactive elements.
- `apps/praxis-desktop/renderer/src/theme.css`: Persona tone styling (`.persona-badge--lead`, `.persona-badge--dev`, `.persona-badge--qa`, `.persona-badge--security`, `.persona-badge--product`).

## Implementation details

- Each assistant turn includes:
  - Header: Persona icon inside tinted badge, persona name (e.g. `QA Specialist`), role tag (e.g. `[QA]`), and time.
  - Body: Rendered with `<Markdown text={message.text} />`.
  - Interactive choices: When `message.choices` are present, renders choice button chips:
    - Clicking a chip dispatches the chosen action prompt directly back into the conversation.
  - Action card: When `message.proposedAction` is present, renders a highlighted proposal block with `[Preview Changes]` and `[Apply]` buttons.
- User messages: Rendered cleanly with right alignment in user accent styling.
- Auto-scroll: Smooth auto-scrolling to bottom on new streaming tokens, pausing if the user manually scrolls up.

## Testing and verification criteria

- Visual test confirming that turns from Dev, QA, Security, and Lead display their distinctive colors and icons.
- Clicking an interactive choice chip triggers the follow-up turn immediately.
- Markdown links, code blocks, and lists format cleanly within message cards.

## Description


## Dependencies



## Comments


