---
**Status:** ✅ Complete
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-153
type: Story
status: Complete
created: 2026-10-03
owner: Electron desktop app
---

# Dockable and floating assistant UI shell with multi-persona chat feed

## Impact

Users gain a versatile, always-accessible assistant interface that operates both as a lightweight floating popover and as a docked right-hand rail column. Messages from different specialists render with distinct avatars, role badges, and brand tones, feeling like an authentic engineering team room.

## Scope

- A global assistant host component mounted at the root in `App.tsx`:
  - **Floating Mode:** Fixed bottom-right popover with a launcher button (`<Icon name="sparkles" />`) and pin control (`<Icon name="pin" />`).
  - **Docked Mode:** Resizable side panel on the right side of the workspace, sharing or adapting `pane-aux` with a drag divider (`useResizable`).
- Keyboard shortcut `Cmd+J` / `Ctrl+J` and TitleBar button for instant summoning from any view.
- Multi-persona message feed:
  - Header per message displaying persona avatar icon, name, role badge, timestamp, and active tone.
  - Full Markdown rendering with syntax highlighting.
  - Interactive choice chips and question buttons embedded inside assistant cards.
- Context pill banner: Indicates the attached page context (e.g. `[ ✕ Context: Issue FX-102 ]`), with quick dismiss to ask general questions.
- Smart composer:
  - Multi-line textarea with Enter to submit and Shift+Enter for newline.
  - `@mention` popup menu to target specific team members (`@lead`, `@dev`, `@qa`, `@security`, `@product`).
  - `[Run Team Review]` quick-action button in the composer toolbar.

## Tasks

| Ref | Task | Status | Priority |
| --- | --- | --- | --- |
| TASK-404 | Global Assistant drawer shell with docked vs floating state and resize handle | Complete | High |
| TASK-405 | Multi-persona message feed component with role badges and interactive choice cards | Complete | High |
| TASK-406 | Context banner, suggestion chips, and composer with mention autocomplete | Complete | High |

## Dependencies

- `FX-BE-152` — Multi-persona team engine and assistant IPC.

## Description


## Comments


