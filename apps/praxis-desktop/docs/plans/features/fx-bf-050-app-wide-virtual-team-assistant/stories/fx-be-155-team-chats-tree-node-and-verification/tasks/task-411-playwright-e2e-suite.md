---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-411
type: Task
status: Backlog
created: 2026-10-03
priority: High
---

# Playwright E2E test suite covering floating/docked toggles, persona chat rendering, and page context switching

## Files and integration points

- `apps/praxis-desktop/main/e2e/assistant.spec.ts` (new): End-to-end test suite for the app-wide assistant.
- `apps/praxis-desktop/main/e2e/launchTestApp.ts`: Test fixture harness seeding test project and mock provider.

## Implementation details

- Test scenarios:
  1. **Summoning & Docking:**
     - Launch app, press `Cmd+J`, verify assistant floating panel opens with focus in composer.
     - Click `[📌 Pin]`, verify layout shifts to docked rail (`.assistant-docked`), verify `.pane-main` width adjusts.
     - Press `Cmd+J` again, verify panel closes.
  2. **Persona Turns & @Mentions:**
     - Open assistant on an issue page, type `@qa what edge cases should I test?`, send.
     - Assert that response renders with QA badge and icon (`.persona-badge--qa`).
  3. **Context Switching:**
     - Navigate from Kanban Board to Issue Detail to Git Changes.
     - Assert that context banner updates dynamically (`Board` → `Issue` → `Git`).
  4. **Team Review Flow:**
     - Click `[Team Review]` button on an open ticket.
     - Assert that sequential turns appear from Dev, QA, Security, and Lead in order.
  5. **Tree Navigation:**
     - Open sidebar, expand `Team Chats`, click an existing chat, verify history loads into assistant drawer.

## Testing and verification criteria

- `npm run test:desktop` passes with all `assistant.spec.ts` tests green.
- No flaky timeouts or race conditions in test harness.

## Description


## Dependencies



## Comments


