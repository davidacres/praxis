---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-238
title: "Wire mobile sessions to live host data"
status: planned
story: FX-BE-081
updated: 2026-09-22
dependencies: [TASK-237]
---

# TASK-238: Wire mobile sessions to live host data

**Priority:** High
**Created:** 2026-09-22

## Goal

Replace canned work and transcript state with host snapshots and events, send follow-up messages through `sessions.continue` to the same durable desktop session, and stream response deltas to the phone as the desktop-hosted agent produces them.

## Implementation entry points

`apps/praxis-mobile/app/store.tsx`, session/sidebar/composer screens, mobile protocol snapshot and event contracts, and the desktop mobile host session handlers.

## Acceptance criteria

- The sidebar lists real active and previous sessions from the connected desktop host, preserving project, session, run, provider, and model identity.
- Selecting a session loads its ordered transcript and live status; reconnect catches up from the event cursor without duplicates or stale data from another host.
- New Chat creates or opens a real host-backed session, and a composer submission invokes `sessions.continue` exactly once for its operation ID.
- Assistant text, reasoning/activity state, tool activity, permission requests, usage, and terminal completion events stream incrementally from the desktop host; the user does not wait for a completed response before seeing progress.
- Streamed deltas remain in protocol order, update one in-progress assistant turn rather than creating duplicate messages, and settle into the same durable transcript shown by desktop.
- Stop/cancel acts on the desktop-hosted active turn. Leaving and reopening the session, backgrounding the app, or briefly losing the network restores the current partial response and resumes from the last acknowledged event cursor.
- The composer and transcript expose sending, active, reconnecting, stopped, failed, and completed states with behavior comparable to an active local chat session, while making desktop execution ownership clear.
- Pending, streaming, completed, failed, denied, offline, empty, and incompatible-capability states are represented without demo fallback.
- Provider and model chips reflect the selected live session; secondary controls remain available through the mobile bottom sheet.

## Dependencies

- TASK-237

## Verification

- Add store and UI tests using protocol fixtures for initial snapshot, token/delta streaming, tool and permission events, terminal completion, cancellation, reconnect replay from a partial response, duplicate suppression, host switching, and failed continuation.
- Verify desktop to phone to desktop continuity against a disposable project and session.
- Build the mobile app and inspect the session sidebar, active response, composer, and reconnect behavior on supported phone sizes and theme axes.

## Done when

- A user can open and continue a real desktop-owned session from the mobile app and watch the response arrive live, with no canned work or transcript data in the production path.
- The same accepted follow-up and resulting events are visible on both clients.

## Notes

This task owns the concrete host-backed integration left out of TASK-222 and TASK-223. It does not add workflow administration or on-device execution.
