---
**Status:** Backlog
**Created:** 2026-09-25T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-045
slug: standalone-conversations
title: Standalone conversations (chat outside any project)
status: Backlog
owner: Electron desktop app
updated: 2026-09-25
stories: [FX-BE-142, FX-BE-143]
---

# FX-BF-045: Standalone conversations (chat outside any project)

## Outcome

A new top-level **Conversations** node in the sidebar tree, positioned between
Overview and Sessions, holding chats that belong to no project and no ticket.
This is plain "talk to the AI" — brainstorming, questions, working through an
idea — not tied to a workflow, board or issue key. Each conversation gets the
same lifecycle actions sessions already have (archive, delete), a permanent
entry point from the app's landing page, and any open conversation can be
popped out into its own floating, resizable, always-on-top window that can be
dragged around the desktop and popped back into the app without losing the
chat.

## Decisions

1. **Reuse `AgentSessionRecord` — no new record type, store, or IPC.** The app
   already has this concept and already names it: `NewSession.tsx` has a "No
   board" option labelled *"Start a completely free-form chat"* and a "No
   ticket" option labelled *"Start a free-form chat session,"* both using the
   `chats` icon. `projectId` on a session is already optional
   (`App.tsx`'s `newSession` navigation only sets it when a project is
   selected). A conversation is simply an `AgentSessionRecord` with no
   `projectId`, no `workflowRunId`, and not a `review~`-prefixed key — the
   same shape today's free-form sessions already have. Building a parallel
   `ConversationRecord` would re-implement a data model, store, and IPC
   surface that already exists and is already labelled for exactly this
   purpose — the kind of duplication `FX-BF-044` was built to remove (~10
   hand-maintained mirrors of provider data caused real drift there).
2. **One new predicate, not a new concept.** `renderer/src/ai/sessionNav.ts`
   already has `isSynthesizedKey`, `isWorkflowStageSession`, and
   `isTicketReviewKey` to classify session identities. A conversation must be
   an explicitly free-form session, not merely a session whose project lookup
   is absent. Add a sibling:
   ```ts
   export function isConversationSession(session: AgentSessionRecord): boolean {
     return isSynthesizedKey(session.issueKey)
       && !isWorkflowStageSession(session)
       && !isTicketReviewKey(session.issueKey);
   }
   ```
   This prevents a ticket-backed session with no associated `projectId` from
   being moved into Conversations. Every surface that needs to distinguish a
   conversation filters on this at display time — there is no storage-time
   split.
3. **Sidebar node mirrors the existing Sessions pattern, positioned above
   it.** `Sidebar.tsx`'s `FEATURES` footer list (`Overview`, `Sessions`,
   `Connections`, `Agent Hub`) is already the app's non-project-scoped
   destination list. Conversations becomes a sibling row between `Overview`
   and `Sessions` — above Sessions because it is the lower-friction entry
   point (no project, no ticket, nothing to set up first), so it reads as the
   first actionable thing on the page. `ConversationsNav` is built the way
   `SessionsNav` already lists sessions: newest first, archive/delete on
   each row, using the `chats` icon. `SessionsNav`'s own input is filtered
   to exclude conversation sessions so nothing double-lists, the same way
   workflow-stage sessions are already partitioned out today.
4. **Conversation view reuses the chat UI, not the session-creation
   chrome.** `SessionComposer.tsx` (the message box) is already decoupled
   from ticket/project context — its own doc comment says it is shared with
   the ticket-review page for exactly that reason — so the conversation view
   reuses it directly. `NewSession.tsx`, the *creation* dialog, is
   task-framed ("What's the goal?", a board-link chip, an "Open ticket" chip,
   a workflow chip) and is not reused as-is: a lightweight, prop-driven
   variant hides the board/ticket chips and swaps the placeholder for
   conversational copy ("Ask anything, brainstorm, or get something
   done…").
5. **A permanent entry point on Overview, not just in the sidebar.**
   `OverviewPage.tsx` is the app's landing screen (`App.tsx`'s default
   route, and where every "reset" path returns). Its hero row gets a third
   button, **New conversation**, given primary visual weight over New
   project/New session since it is the lowest-friction action. A sibling
   "Recent conversations" panel is added next to "Active AI sessions" —
   not folded into it, since that panel's empty-state copy and
   `!isTerminalAgentState` filter are built for tracking in-progress task
   work, not idle chats. `GettingStarted.tsx`'s existing "Continue with
   Empty Workspace" / "Skip for now" paths already land a brand-new user on
   this same Overview screen with nothing configured, so no new first-run
   screen is needed.
6. **The "Start here" onboarding strip must not be silently suppressed by a
   conversation.** Overview's 3-step strip ("Create a project → Connect your
   tracker → Start an AI session") is gated on
   `projects.length === 0 && sessions.length === 0`. Because a conversation
   is now an `AgentSessionRecord`, starting one first would make
   `sessions.length > 0` and hide that strip even though the user still has
   zero projects. The gate changes to exclude conversation sessions:
   `projects.length === 0 && sessions.filter(s => !isConversationSession(s)).length === 0`.
7. **Storage is already correct — no change.** Sessions persist in
   `ai-sessions.json` under Electron's `userData` directory, which is
   already per-OS-user and local-only (no cloud sync or shared backend
   exists anywhere in `main/src`). A conversation is just an entry in the
   same file whose `projectId`/`workflowRunId`/ticket fields are absent, so
   it already survives the same backup/restore path and the existing
   `migrateLegacyUserData()` one-time copy with no new code.
8. **The floating window is a second real `BrowserWindow`, with an explicit
   lifecycle.** Today
   `createMainWindow` (`main/src/main/index.ts:216`) is the only window this
   app ever creates — it's explicitly single-window, frameless, with a custom
   title bar. The main process owns a `detachedSessionKey` registry and IPC
   commands to pop out, pop in, and handle native window close. Popping out
   opens a second **native-framed** `BrowserWindow` (always-on-top,
   resizable, user-draggable) loading the same renderer at
   `?detachedSession=<issueKey>`. Native framing deliberately provides a
   platform-consistent close control; the renderer also supplies an explicit
   pop-in action. The second window inherits the renderer's static CSP but
   needs its own navigation guard and `windowOpenHandler`, mirroring
   `attachMainWindowNavigationGuard`. The pop-out button lives in the
   conversation's own header/toolbar, not on the sidebar row.
9. **One live subscription and one rendering surface.** The main process
   owns conversation state and streaming; the detached-window registry is the
   authority for which renderer receives the live update subscription.
   Popping out unregisters the main-window surface before registering the
   floating one; pop-in, native close, or app shutdown clears the registry
   and returns selection to the main window. This avoids two windows racing
   to render a stream and ensures a conversation is reachable after relaunch.

## Scope

- `isConversationSession` predicate based on the synthesized free-form
  session identity (`renderer/src/ai/sessionNav.ts`) — FX-BE-142
- Sidebar: top-level **Conversations** row + `ConversationsNav` between
  Overview and Sessions, `SessionsNav` filtered to exclude conversations,
  `chats` icon, correct `--tree-indent` token — FX-BE-142
- Lightweight "New conversation" entry point (prop-driven `NewSession.tsx`
  variant, chips hidden, conversational placeholder) — FX-BE-142
- Command palette entry, mirroring the existing per-session `.forEach` block,
  filtered to conversations — FX-BE-142
- Overview page: primary "New conversation" hero button, "Recent
  conversations" panel, starter-strip gating fix — FX-BE-142
- Pop-out: button in a conversation's header creates a floating, resizable,
  draggable, always-on-top window showing that conversation — FX-BE-143
- Pop-in: button on the floating window (and its native close [x]) returns
  the conversation to the main window instead of discarding it — FX-BE-143
- Floating window position/size remembered across pop-outs — FX-BE-143

## Out of scope

- A separate `ConversationRecord` type, store, or IPC surface — superseded by
  Decision 1; conversations ride the existing session engine entirely.
- Multi-participant or shared conversations — single user only.
- Project- or ticket-linked chat — that's the existing AI session flow, not
  this feature.
- Mobile app support for standalone conversations (desktop only for v1).
- Conversation search/export (future).
- Per-conversation model/provider selection beyond whatever the app's
  current default-provider picker already offers.
- Multiple internal Praxis profiles sharing one OS login — storage isolation
  is already per-OS-user, which is what this feature needs; a Praxis-level
  login/profile system is a separate, much larger feature if ever needed.

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-142 | Conversations list and lifecycle | Proposed | — |
| FX-BE-143 | Floating chat window | Proposed | FX-BE-142 |

## Dependencies

- `FX-BF-035` — multi-AI session orchestration; the chat composer/message
  components this feature reuses live there.
- `FX-BF-041` — usage ledger; standalone chat spend is already tracked like
  any other session, with no new attribution work needed.

## Risks or open questions

- **Stream ownership handoff.** Popping a conversation out or back in
  mid-response must not drop or duplicate tokens — the main-process detached
  registry is the single authority for the renderer subscription (Decision 9).
- **Starter-strip regression.** If the gating fix (Decision 6) ships in a
  different change than the Conversations entry points, the first user to
  chat before creating a project silently loses the "Create a project" nudge.
  Both must land together.
- **First second-window in the app.** Always-on-top + frameless drag/resize
  needs verifying on macOS, Windows and Linux; native framing is chosen so
  each platform supplies a consistent close control. The floating window
  needs its own `BrowserWindow` options reviewed against the same
  navigation-guard logic `attachMainWindowNavigationGuard` applies to the
  main window.
- **Orphaned floating windows on quit/relaunch.** The app must not leave a
  detached window with no way to reattach it if the app was killed while a
  conversation was floating.

## Close when

From a fresh app window, a user can start a new conversation from either the
sidebar or the Overview hero button with no project attached, talk with the
AI, archive and delete it the way they already can with a session, pop it
into a floating always-on-top window they can drag and resize, and pop it
back into the main app without losing any of the conversation — and a user
who still has zero projects still sees the "Create a project" onboarding
strip after starting their first conversation.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments
