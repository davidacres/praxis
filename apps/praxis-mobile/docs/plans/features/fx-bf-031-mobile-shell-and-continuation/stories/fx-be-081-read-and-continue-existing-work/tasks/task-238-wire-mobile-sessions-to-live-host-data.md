---
**Status:** 🔄 In Progress
**Type:** Task
type: Task
id: TASK-238
title: "Wire mobile sessions to live host data"
status: in-progress
story: FX-BE-081
updated: 2026-09-23
dependencies: [TASK-237]
---

# TASK-238: Wire mobile sessions to live host data

**Priority:** High
**Created:** 2026-09-22

## Goal

Replace canned work and transcript state with host snapshots and events, send follow-up messages through `sessions.continue` to the same durable desktop session, and stream response deltas to the phone as the desktop-hosted agent produces them.

## Implementation entry points

`apps/praxis-mobile/app/store.tsx`, a connection-backed mobile session repository, session/sidebar/composer screens, `packages/core/src/host/mobileProtocol.ts`, the desktop `mobileHostServices.ts` / `mobileHostComposition.ts`, `AiSessionManager` change notifications, and `AgentSessionRecord.events`.

## Required implementation

### Shared session contract

- Add typed, versioned reads for `sessions.list` and `sessions.get`, commands for `sessions.create`, `sessions.continue`, and active-turn stop/cancel, plus capability metadata that lets the UI disable unsupported actions with a reason.
- Define a session summary and snapshot containing stable host/project/session/work/run/parent IDs, title, lifecycle state, provider/model context, permission mode, usage, highest event sequence, and an ordered transcript projection.
- Define a discriminated event union for user-message acceptance, assistant text delta, reasoning/activity state, tool start/update/end, permission request/resolution, usage update, turn stopped/failed/completed, session metadata, and deletion/archive. Every event carries stable session, turn, event, and sequence identity.
- Specify merge rules: events are monotonic and idempotent by host/session/event ID; text deltas append only to their turn; snapshots replace through a declared sequence; terminal events settle one turn; late or duplicate events never create a second transcript entry.

### Praxis desktop

- Replace the empty `MobileSessionView.transcript` projection with a browser-safe projection from `AgentSessionRecord.events`, using `responseText` only as the active-turn buffer and never as reopened transcript history.
- Implement real composition handlers for create, continue, and active-turn cancellation through the same session manager/launcher APIs used by desktop. Preserve cwd/project/provider/model/permission context and command idempotency; remove the corresponding `MobileHostPendingError` path.
- Bridge session-manager changes into the mobile event ledger while a turn is running, including partial text and tool/permission lifecycle. Filter snapshots, replay, and live pushes by the authenticated device's host/project/session scope so one paired client cannot receive another project's events.
- Make replay bounded and durable enough for disconnect/background recovery. If the requested cursor is unavailable after compaction or desktop restart, return `cursor-expired` plus a fresh authoritative snapshot path instead of silently starting at zero.
- Ensure the desktop renderer and mobile projection consume the same durable session events so both clients converge after completion, cancellation, failure, archive, deletion, and application restart.

### Praxis mobile

- Replace `DemoWorkItem`, `DemoTranscriptMessage`, `DEMO_TRANSCRIPTS`, fake New Chat, and timer-based follow-ups in the production store with typed host repositories and reducers; keep demo fixtures importable only from explicit development/test composition.
- Hydrate the sidebar from `sessions.list`, preserve parent/run grouping and active/previous state, and route New Chat through `sessions.create`. A chat header shows the live session title and has no back-to-sessions page.
- Project snapshots and events into one normalized per-host/per-session store. Render the active assistant turn incrementally, preserve scroll position and drafts, and reconcile a snapshot/replay without flicker, loss, or duplicate messages.
- Send stable command IDs, show pending acknowledgement separately from an active response, and expose Stop only while the desktop owns an active turn. Disable send/stop while reconnect reconciliation is incomplete.
- Populate the provider and model chips from session capability/context data. Put other supported controls in the bottom sheet and show unavailable controls with host-supplied reasons rather than hard-coded values.
- Keep cached transcript metadata and drafts scoped by host and session with a documented retention policy; never persist secrets or raw sensitive tool arguments.

## Acceptance criteria

- The sidebar lists real active and previous sessions from the connected desktop host, preserving project, session, run, provider, and model identity.
- The protocol exposes and the mobile app uses real list/create/continue/cancel operations; New Chat and Stop are not local-only UI mutations.
- Selecting a session loads its ordered transcript and live status; reconnect catches up from the event cursor without duplicates or stale data from another host.
- New Chat creates or opens a real host-backed session, and a composer submission invokes `sessions.continue` exactly once for its operation ID.
- Assistant text, reasoning/activity state, tool activity, permission requests, usage, and terminal completion events stream incrementally from the desktop host; the user does not wait for a completed response before seeing progress.
- Streamed deltas remain in protocol order, update one in-progress assistant turn rather than creating duplicate messages, and settle into the same durable transcript shown by desktop.
- Live pushes, replay, and snapshots are filtered from authenticated desktop scope; two devices with different project grants cannot observe each other's session metadata or event payloads.
- A cursor lost through compaction or desktop restart triggers one bounded snapshot replacement and then resumes live events from its returned sequence.
- Stop/cancel acts on the desktop-hosted active turn. Leaving and reopening the session, backgrounding the app, or briefly losing the network restores the current partial response and resumes from the last acknowledged event cursor.
- The composer and transcript expose sending, active, reconnecting, stopped, failed, and completed states with behavior comparable to an active local chat session, while making desktop execution ownership clear.
- Pending, streaming, completed, failed, denied, offline, empty, and incompatible-capability states are represented without demo fallback.
- Provider and model chips reflect the selected live session; secondary controls remain available through the mobile bottom sheet.

## Dependencies

- TASK-237

## Verification

- Add protocol contract/validation tests for all session reads, commands, snapshot fields, event variants, merge rules, capability failures, and malformed/untrusted payloads.
- Add desktop tests proving historical transcript projection uses `AgentSessionRecord.events`, active text streams before completion, create/continue/cancel call the existing session lifecycle once, replay is scope-filtered, and cursor expiry returns snapshot fallback.
- Add mobile repository/reducer and UI tests for initial snapshot, token/delta streaming, interleaved tool and permission events, terminal completion, cancellation, reconnect replay from a partial response, snapshot replacement, duplicate/out-of-order suppression, host switching, archive/delete, and failed continuation.
- Verify desktop to phone to desktop continuity against a disposable project and session, including app background/return and desktop restart during a partial response.
- Build the mobile app and inspect the session sidebar, active response, composer, and reconnect behavior on supported phone sizes and theme axes.
- Required repository checks: `npm run check-types`, `npm run test:mobile-protocol`, `npm run test:mobile`, `npm run test:desktop:mobile`, and `npm run build`. Add a focused Electron/React Native integration journey that fails if session data is empty, demo-backed, unscoped, or delivered only after terminal completion.

## Done when

- A user can open and continue a real desktop-owned session from the mobile app and watch the response arrive live, with no canned work or transcript data in the production path.
- The same accepted follow-up and resulting events are visible on both clients.
- New Chat, Send, Stop, reopen, reconnect, archive/delete reflection, provider/model context, and permission/tool activity all use the production host contract and have automated cross-app evidence.
- No `MobileHostPendingError`, empty transcript placeholder, self-asserted scope, or demo import remains on the supported production session path.

## Notes

This task owns the concrete host-backed integration left out of TASK-222 and TASK-223. It does not add workflow administration or on-device execution. Completion evidence must include real desktop composition, live event publication, the mobile repository/reducer, clean builds, focused tests, and an inspected running journey; DTOs, helper reducers, or mock-host evidence alone cannot close it.

## Progress (2026-09-23)

Source work for this task's provider/model chips from host data, host-reasoned unavailable controls, usage, and sequence-guarded snapshot/replay merging is implemented and covered by protocol, desktop and
mobile tests plus `mobileEndToEnd.test.ts` (real listener + host services + the
phone's client). The iOS Release build is installed on a physical iPhone and
launches (`Running "main"`). Still open: the recorded physical-device journey
against a desktop running revision 2, and Android. Status stays In Progress.

## Description


## Comments


