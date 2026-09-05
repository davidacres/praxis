# FX-BE-037 — Command palette issue search

**Type:** Story  **Status:** Complete  **Priority:** P2  **Depends on:** FX-BF-005

## Business or operational impact
⌘K indexed projects, boards, sessions, agents, workflows and settings but never a ticket — the one thing users look for daily. Issues aren't held in App state (each board pages its own from `issue:list`), so unlike every other entry this couldn't be a static index.

## Scope
- `CommandPalette` gains a debounced, race-guarded async `onSearch` path, appended under an "Issues" group once the static list is scored and sorted.
- App's `searchIssues` queries every board in the current workspace in parallel via `issue:list`, scoped by that board's `boardId`/`projectKey` the same way `BoardView.scopedFilters` does.
- A dead connection on one board never blocks results from the others (`Promise.allSettled`); capped at 6 results per board, 25 total.

## Acceptance criteria
- Typing a ticket's key or summary text (2+ characters) surfaces it in the palette within ~200ms of the last keystroke.
- Selecting a result navigates to that board with the issue open.
- One unreachable connection does not suppress results from other boards.

## Validation
- `npm run check-types`
- `npm run test:desktop` (`commandPalette.spec.ts`)

## Close when
⌘K finds a ticket by key or summary text as reliably as it finds a board or session.
