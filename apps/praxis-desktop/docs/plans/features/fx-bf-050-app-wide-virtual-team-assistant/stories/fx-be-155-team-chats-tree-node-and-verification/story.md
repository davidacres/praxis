---
**Status:** ✅ Complete
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-155
type: Story
status: Done
created: 2026-10-03
owner: Electron desktop app
---

# Team Chats sidebar tree node, persistence, and visual verification

## Impact

Conversations with the virtual engineering team are preserved as permanent project assets and presented directly in the Project sidebar tree under a dedicated `Team Chats` category. The complete experience is hardened with Playwright end-to-end tests and visual screenshot baselines across all themes.

## Scope

- Sidebar integration in `Sidebar.tsx`:
  - New expandable section `Team Chats` under each project in the tree.
  - Lists project discussions with timestamp, active personas, and ticket badges (if bound to an issue).
  - Quick action button `[+] New Chat` to start a fresh thread.
  - Selecting a chat opens the assistant drawer loaded with that conversation.
- Persistence backend:
  - Stores `TeamChatRecord` entities in project store or dedicated json store.
  - Automatic naming based on initial user query or lead summary.
  - Renaming and deleting chats via context menu.
- Verification & Testing:
  - Playwright e2e test suite covering summoning (`Cmd+J`), docking, undocking, asking questions, `@mention` turns, context switching, and team reviews.
  - Visual screenshot baselines for floating and docked states across light/dark modes and surface pack themes.
  - Feature documentation update in `apps/praxis-desktop/docs/desktop-feature-parity.md`.

## Tasks

| Ref | Task | Status | Priority |
| --- | --- | --- | --- |
| TASK-410 | Team chat persistence and Project tree `Team Chats` sidebar node | Complete | High |
| TASK-411 | Playwright E2E test suite covering floating/docked toggles, persona chat rendering, and page context switching | Complete | High |
| TASK-412 | Visual inspection, surface pack theme validation, and desktop documentation updates | In progress | Medium |

## Dependencies

- `FX-BE-153` — Dockable and floating assistant UI shell with multi-persona chat feed.
- `FX-BE-154` — Page context providers and interactive in-app actions.

## Description


## Comments

**2026-10-10:** Closed during backlog review: delivered by FX-BF-050 — the assistant is built and covered by assistant.spec.ts, and the parity doc (desktop-feature-parity.md) and renderer/AGENTS.md already document it.
