---
**Status:** ✅ Complete
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-406
type: Task
status: Complete
created: 2026-10-03
priority: High
---

# Context banner, suggestion chips, and composer with mention autocomplete

## Files and integration points

- `apps/praxis-desktop/renderer/src/assistant/AssistantComposer.tsx` (new): Multi-line text input with submit button, mention popup, and team action toolbar.
- `apps/praxis-desktop/renderer/src/assistant/AssistantContextBanner.tsx` (new): Context pill showing active page association and suggested quick-prompt buttons.
- `apps/praxis-desktop/renderer/src/assistant/useAssistantMention.ts` (new): Autocomplete hook for `@` character triggers.

## Implementation details

- Context Banner:
  - Located above the composer or below the header.
  - Displays `[ ✕ Context: <Title> ]` (e.g. `[ ✕ Context: Board - Sprint 4 ]` or `[ ✕ Context: Issue FX-102 ]`).
  - Clicking `✕` temporarily detaches page context for the current turn.
  - Suggestion chips: Renders horizontal scrollable pills with 2-3 quick questions tailored to the page (e.g. `Suggest test plan`, `Check security`, `Summarize blockers`).
- Composer:
  - Textarea auto-expanding up to 6 lines, Enter sends, Shift+Enter adds newline.
  - Typing `@` triggers a floating menu with personas (`@lead`, `@dev`, `@qa`, `@security`, `@product`). Keyboard navigation (up/down/enter) inserts the token.
  - Dedicated `[✨ Team Review]` button in the composer footer to trigger an all-hands evaluation of the current page.

## Testing and verification criteria

- Typing `@` and selecting an item from the menu inserts the mention tag cleanly.
- Clicking a suggestion chip populates the input and sends the query.
- Detaching context removes the context badge and confirms the turn sends without page context data.

## Description


## Dependencies



## Comments


