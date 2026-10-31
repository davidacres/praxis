---
**Status:** 📋 Proposed
**Created:** 2026-10-31T02:46:10.517Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-113
type: Feature
status: To Do
---

# FX-BF-113: Slim shelf creation and linked notes

## Outcome

Create sessions and capture private-to-the-user notes from the existing shelf, organise the same notes in the sidebar, link them through named groups, and explicitly send a note or group to a session. Writing, saving, opening, and grouping notes never invokes AI.

## Scope and exclusions

- New-session control within the existing shelf; route through the established session creation flow without auto-sending a prompt.
- Notes access from both the shelf and sidebar, using one persistent collection and editor state.
- Create, edit, rename, delete, and reopen notes; named groups link existing notes without merging or duplicating their content.
- Select a note or group, choose an existing or new session, preview the content, and explicitly send it.
- Scheduled runs are excluded entirely: no schedule picker, run attachment, scheduler changes, automatic execution, or scheduled-run acceptance criteria.
- No board-ticket conversion, mobile parity, cloud sync, AI summarisation, or automatic note sharing in this phase. Existing Quick Capture (FX-BE-158) creates board items and remains separate.

## Visual and interaction contract

Reference: `.praxis/session-artifacts/notes-fixed-rail/index.html` and `five-measured-designs.png`. These are design references, not implemented UI. Use the etched-pencil treatment as the planning baseline; the five variants are alternatives, not five controls to implement.

The shelf remains exactly 14 CSS pixels wide at the standard scale. Preserve its existing width and workspace inset at every supported UI scale, zoom, theme, empty state, and populated state. New controls occupy vertical space inside the current rail; neither padding, borders, focus rings nor invisible hit areas may increase its layout allocation. Only the revealed sleeve extends into the workspace. It stays flush with the rail and slides from that edge, retaining the current shelf metaphor. Do not replace it with a floating panel or expanded sidebar.

Use compact outline plus/pencil marks, existing theme and surface tokens, fine borders, typography and row density. Show accessible tooltips and focus indicators. The expanded sidebar has a Notes section with ungrouped notes and expandable named groups in both Classic and Easy Mode. Shelf and sidebar open the same note, not independent drafts. Ensure controls remain reachable when session spines fill the rail; use vertical allocation/overflow without horizontal expansion.

## Data and behaviour decisions

For this phase notes belong to the selected project, persisted in app-owned local storage independently of sessions and board backends. Do not write notes into the repository or workspace export. Capture without an active project asks for a project before saving. Project switches must not lose edits or silently move a note.

Use stable IDs, title, body, project ID and timestamps. A group has its own ID, title and ordered member-note IDs; one note may appear in multiple groups within its project. Editing a linked note updates all views. Removing membership or deleting a group preserves notes; deleting a note removes its memberships after the established in-app confirmation. No nested groups in this phase. Display empty and missing-member states deliberately.

Autosave locally with a visible saving/saved/error state. Flush pending edits before closing or switching, preserve unsaved text on failure, and restore after restart. Do not imply a failed save succeeded. Keep persistent notes separate from SessionShelf's existing window-local reply drafts.

Sending is explicit: select destination, review a snapshot with note titles and stable group order, optionally add an instruction, and press Send. Opening the picker or creating the destination never sends. Snapshot content is recorded in the session request; subsequent note edits do not rewrite past messages. Reuse session submission and context-reference patterns, treating note content as reference data. Preserve drafts and notes on provider failure, guard duplicate clicks, and offer a clear retry. No ongoing live link is created with the destination session.

## Implementation seams

- Shared serialisable note/group contracts and validation belong in `packages/core`; renderer imports types only.
- Main owns app-local persistence, project ownership checks and typed IPC; preload exposes narrow CRUD/membership APIs.
- Renderer owns the notes feature, the shared editor and action flow; integrate `SessionShelf`, `Sidebar`, `EasyModeSidebar`, and `App` without rebuilding their session organisation.
- Inspect and reuse the current `SessionContextPicker` / `sessionContext.ts` and session creation/submission flow. Those files currently contain ongoing workspace work; reconcile at implementation time and preserve unrelated edits.

## Delivery and acceptance

Deliver persistence first, then shared capture/sidebar access, then session reuse, then full verification. All child stories must pass before completion. Record exact suite results and any blockers; a focused pass does not establish full-suite success. Preserve screenshots of actual app interactions under `.praxis/session-artifacts/` for handoff. This document authorises planning only, not implementation.

## Dependencies

None

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments
