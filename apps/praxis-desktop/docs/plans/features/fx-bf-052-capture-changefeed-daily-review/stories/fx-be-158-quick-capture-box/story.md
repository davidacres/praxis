---
**Status:** 📋 Proposed
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Story
**Priority:** Medium
id: FX-BE-158
type: Story
status: Backlog
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

- [ ] Design capture overlay component and shortcut registration
- [ ] Implement stub creation with origin marker in the board store
- [ ] Backlog "captured" badge and triage affordance
- [ ] E2E coverage for shortcut, escape, focus-return, and rapid capture

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


