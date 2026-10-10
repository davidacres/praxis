---
**Status:** ✅ Complete
**Created:** 2026-09-06T13:13:26.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-037
title: Command palette issue search
status: Done
feature: FX-BF-017
issue: docs/issues/features/fx-bf-017-ai-session-ux-and-workflow-ticket-integration/stories/fx-be-037-command-palette-issue-search/issue.md
updated: 2026-10-10
commits: [fd6a0f9]
dependencies: [FX-BF-005]
validation: [npm run check-types, npm run test:desktop]
---

# Command palette issue search

## User or operational impact

⌘K indexed projects, boards, sessions, agents, workflows and settings — but
never a ticket, the one thing users look for daily. Issues aren't held in App
state (each board pages its own from `issue:list`), so unlike every other entry
this could not be a static index.

## As built (`fd6a0f9`)

- `CommandPalette` gains a debounced, race-guarded async `onSearch` path,
  appended under an "Issues" group **after** the static list is scored and
  sorted — so a slow query never reorders the instant results.
- App's `searchIssues` queries every board in the current workspace in parallel
  via `issue:list`, scoped by that board's `boardId`/`projectKey` exactly the
  way `BoardView.scopedFilters` does.
- `Promise.allSettled`, so one dead connection cannot suppress results from the
  other boards. Capped at 6 results per board, 25 total.

## Acceptance criteria — verified

- Typing a ticket key or summary text (2+ chars) surfaces it within ~200ms of
  the last keystroke.
- Selecting a result navigates to that board with the issue open.
- One unreachable connection does not suppress results from other boards.

## Tests

`commandPalette.spec.ts` (e2e), plus a UI capture
`output/playwright/command-palette-issue-search.png`.

## Description


## Dependencies



## Comments

**2026-10-10:** Closed during backlog review: all items in this feature are delivered and recorded as Complete in its Items table / 'As built' notes; the header status had not been rolled up.
