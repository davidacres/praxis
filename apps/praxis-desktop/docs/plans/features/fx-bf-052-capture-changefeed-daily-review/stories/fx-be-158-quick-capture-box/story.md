---
**Status:** Done
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Story
**Priority:** Medium
id: FX-BE-158
type: Story
status: Done
created: 2026-10-04
priority: Medium
---

# Quick capture box

## Impact

A user can press a global shortcut (or click a persistent capture affordance) from anywhere in the app, type a short task note, and return to exactly what they were doing. The note lands in the project backlog as a ticket stub without requiring title/status triage.

## Scope

Global capture overlay (input + optional target), persisted ticket stub creation via the existing board store, shortcut registration, and an inbox-style destination (Backlog) with a recognizable "captured" marker so stubs can be triaged later. No rich text, attachments, or AI parsing in v1.

## Acceptance criteria

1. A keyboard shortcut (e.g. `Cmd/Ctrl+K` shift or a dedicated combo chosen to avoid conflicts) opens a capture overlay from every page in the app, including over modals and panes.
2. Submitting text creates a ticket stub in the active project's Backlog with the text as the title, a "captured" origin marker, and a creation timestamp; the overlay closes and focus returns to the previously focused element.
3. `Escape` closes the overlay with no ticket created and no state changes.
4. Empty or whitespace-only submissions are rejected with inline feedback and no ticket.
5. The capture box is also reachable via a persistent UI affordance (TitleBar or launcher) for mouse-only users.
6. Rapid successive captures work: capturing 3 notes in a row produces 3 distinct backlog stubs in capture order.
7. Captured stubs are visually distinguishable from fully-triaged tickets on the board.
8. Overlay renders correctly across the theme/mode and zoom matrix used by other app surfaces.

## Tasks

- [x] Design capture overlay component and shortcut registration
- [x] Implement stub creation with origin marker in the board store
- [x] Backlog "captured" badge and triage affordance
- [x] E2E coverage for shortcut, escape, focus-return, and rapid capture

## Verification

1. Open the overlay from board, sessions, git diff, and a modal; submit a note; confirm a Backlog stub appears.
2. Verify `Escape` and empty-input paths.
3. Run `npm run check-types` and desktop E2E suite.

## Dependencies

FX-BF-052. Existing board store and ticket schema.

## Close conditions

All acceptance criteria pass; E2E coverage merged; no shortcut conflicts documented in the PR description.

## Description


## Comments

### 2026-10-11 — implementation evidence

Delivered: TitleBar affordance and `⌘⇧C` / `Ctrl+Shift+C` open `issues/QuickCapture.tsx` from anywhere; creation goes through the ordinary `issue:create` path, so each backend's own permission (`allowIssueCreation`) and parent rules apply unchanged. No active project → the user must choose a destination; nothing is silently picked. A refused or failed save keeps title, body and destination (also across dismiss/reopen); input clears only on success. Fixed: Escape did nothing after a failed save (disabled controls dropped focus to `<body>`).

Verified: `e2e/quickCapture.spec.ts` (4 tests, repeated 4×, all pass).

Open against the criteria: AC2/AC7 "captured" origin marker and board badge — `CreateIssueInput` has no labels field, so this needs a cross-backend schema change; left as a follow-up rather than done per backend.

### 2026-10-11 — QA review against the criteria

Added to `e2e/quickCapture.spec.ts`: focus returns to the opener after a save (AC2; proven to fail with the restore removed), a whitespace-only title cannot be saved (AC4), and three successive captures create three distinct items (AC6). Fixed: the close button sat beside the title instead of at the dialog's edge.

Still open: AC2/AC7 "captured" marker and board badge (above); AC8 theme/zoom matrix not checked — one light-theme capture only.

### 2026-10-11 — AC8 theme/zoom and security pass

AC8 now covered: `e2e/quickCapture.spec.ts` opens the dialog at 150% whole-window zoom and sweeps 12 themes × 5 surface packs (56 combinations). The dialog stays inside the window in every one (proven to fail with the dialog forced taller than the window), and its heading and input text reach WCAG AA or the palette's own text ceiling. A settled native capture (`quick-capture-dark-150.png`, praxis-dark/graphite) was inspected.

Found, not fixed here (app-wide, not Quick Capture's): the shared `.btn-primary` misses 4.5:1 in github-dark (3.75), xcode-light (3.65), solarized-light/aurora-glass (3.68), tm-default-1 (4.35) and humanist-light (4.41); the shared dialog-field label is 4.06:1 in catppuccin-latte. The spec holds those primitives at a 3:1 legibility floor so a gross regression still fails.

Security: no concern. Captured text reaches the backend only through `issue:create` and is rendered as React text. The new `activity:list` handler validates that its project exists; like every other `ipcMain` handler it does not yet check the sender frame — already tracked as F107 task 107.1.

### 2026-10-11 — AC2/AC7 captured marker and badge

Delivered: an optional `origin: 'capture'` (`IssueOrigin`) on `CreateIssueInput`/`IssueSummary`, recorded only by the backends Praxis owns. App storage keeps it on the work item. Folder writes one creation-only `**Origin:** capture` line, deliberately not a `FIELD_RULE`, so the `ensureFrontMatter` upgrade pass never adds or rewrites it. The parser accepts only the literal `capture`. GitHub, GitLab and Jira ignore the field. Quick Capture always sends it.

The board shows a dashed **Captured** badge (card and list views) while a captured item sits in its board's first column. Moving it on is the triage: the badge clears, and the origin line stays on disk as provenance. Nothing ever has to rewrite the marker.

Verified: `e2e/quickCapture.spec.ts` (7 pass). The new folder test checks the line on disk, the badge on the captured card, no badge on a hand-written ticket, and the badge clearing after a move to In Progress. It was proven to fail twice: once with the column rule removed, and once with Quick Capture not sending the origin. Core unit tests cover the folder round trip (including the upgrade pass and a forged value) and app-storage persistence. The folder gate (`folder`/`folderMulti`/`editIssue`/`newIssue`) passes 14/14; the 13 in `AGENTS.md` predates a test added to `newIssue.spec.ts`. The badge capture `quick-capture-badge.png` was inspected.

### 2026-10-11 — remaining criteria and the shared contrast fix

- **AC4:** a whitespace-only title now shows inline feedback ("A title can't be only spaces.", `aria-invalid` on the field) as well as disabling Save.
- **AC1:** a new test opens the capture with the shortcut over Settings and over the open command palette (focus in its search field), and checks the capture is the topmost element.
- **AC2:** a new test checks the created item carries a creation timestamp taken at save time.
- **AC3:** Escape now has a no-change test. Every key on every reachable board is identical before and after.
- **AC6:** the rapid-capture test now checks capture order (keys and creation times ascending).

**Contrast, fixed app-wide:**
- **github-dark:** accent text is now dark (`#0d1117`), the convention one-dark, nord and dracula already use.
- **xcode-light, solarized-light, tm-default-1, humanist-light:** the accent is a few percent deeper (`#0973de`, `#217ab9`, `#7758f5`, `#b25c43`). That brings white button text to 4.6:1 or better and also helps accent-coloured text on those light surfaces.
- **catppuccin-latte:** `--text-secondary` uses the palette's own Subtext1 (`#5c5f77`, 5.1:1).
- **Guard:** the theme sweep's 3:1 floor for label and primary button is gone. All four parts now need WCAG AA (or the palette's own text ceiling).
- **Proven:** with xcode-light's old accent restored, the sweep failed (`save 3.65:1`, needs 4.45).

Verified: `e2e/quickCapture.spec.ts` 9/9; the whitespace hint was proven to fail with its render removed.

### 2026-10-11 — closeout status and verification

Existing full-run log records all 9 `quickCapture.spec.ts` tests passing, including shortcut over dialogs, creation time, Escape without creation, capture order, failure preservation and theme/zoom contrast. The implementation and acceptance evidence above close this story.

The existing detached run (`/tmp/sd3-full.log`) finished: **590 passed, 3 skipped, 1 failed**. These are prior-run results, not a new run. E2E tests were not run during this closeout, as requested.
