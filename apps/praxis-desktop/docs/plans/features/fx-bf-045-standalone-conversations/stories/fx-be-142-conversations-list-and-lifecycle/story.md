---
**Status:** Backlog
**Created:** 2026-09-25T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-142
title: "Conversations list and lifecycle"
status: Backlog
feature: FX-BF-045
updated: 2026-09-25
dependencies: []
---

# FX-BE-142: Conversations list and lifecycle

## User or operational impact

Gives users a place to talk to the AI — brainstorm, ask questions, think
something through — without first creating a project or ticket, reachable
both from the sidebar and from the app's landing page. This is the
foundation the floating window (FX-BE-143) sits on top of.

## Scope

- `isConversationSession` predicate in `renderer/src/ai/sessionNav.ts`,
  alongside the existing `isSynthesizedKey`/`isWorkflowStageSession`/
  `isTicketReviewKey`: require a synthesized free-form `SESSION-…` identity,
  then exclude workflow-stage and ticket-review sessions. Do not classify
  solely by a missing `projectId`: a ticket-backed session may legitimately
  lack a project association. No new record type, store, or IPC — a
  conversation is an `AgentSessionRecord` with the existing free-form
  identity.
- Sidebar: new top-level **Conversations** row, positioned between
  `Overview` and `Sessions` in `Sidebar.tsx`'s `FEATURES` list, using the
  `chats` icon. `ConversationsNav` lists the subset of `sessions` matching
  `isConversationSession`, built the way `SessionsNav` already lists
  sessions: newest first, with archive and delete actions per row, correct
  `--tree-indent` token for its depth. `SessionsNav`'s own input is filtered
  to exclude these sessions so nothing double-lists.
- Archive semantics match the existing session pattern exactly: archiving
  collapses a conversation out of the active list but keeps it reachable;
  delete removes it permanently behind a confirmation. Both reuse the
  existing session IPC unchanged, since a conversation's `issueKey` is a
  normal session key.
- Lightweight "New conversation" entry point: a prop-driven variant of
  `NewSession.tsx` with the board-link and ticket chips hidden and the goal
  placeholder swapped to conversational copy ("Ask anything, brainstorm, or
  get something done…"), wired from the sidebar row's `+` button and from
  Overview.
- Command palette: a second `.forEach` block alongside the existing
  per-session entries in `App.tsx`'s `paletteEntries`, filtered to
  conversations, grouped as "Conversations."
- Overview page (`OverviewPage.tsx`): hero row gets a third, primary "New
  conversation" button; a new "Recent conversations" panel (own empty state,
  `chats` icon) sits alongside "Active AI sessions"; the "Start here"
  3-step strip's gating condition changes from
  `projects.length === 0 && sessions.length === 0` to
  `projects.length === 0 && sessions.filter(s => !isConversationSession(s)).length === 0`
  so starting a conversation first doesn't hide the project-onboarding nudge.
- Conversation detail view reuses the existing `SessionComposer` and message
  rendering directly — already decoupled from ticket/project context — with
  no project/ticket/workflow chrome around it.
- Conversations are visible regardless of the active workspace/project
  filter — they don't belong to any project, so they aren't scoped by one.

## Acceptance criteria

- Creating a conversation (from the sidebar `+` or the Overview hero button)
  adds it to the Conversations node immediately, independent of any selected
  project or workspace, and does not appear under Sessions.
- Archiving a conversation removes it from the active list but it remains
  reachable (matching session archive behaviour); deleting removes it for
  good after confirmation.
- A conversation can be chatted in using the same composer/message UI as an
  AI session, with no ticket or board reference anywhere in the view.
- A conversation is findable by name in the command palette (⌘K).
- Starting a conversation as a user's very first action, before creating any
  project, still leaves the "Start here" onboarding strip visible on
  Overview.
- Conversation list and message history persist across app restarts (via
  the existing session store — no new persistence code).
- A ticket-backed session without a `projectId` remains under Sessions, never
  in Conversations.

## Validation

- `npm run check-types`
- `npm run build:renderer`
- `npm run desktop:copy-renderer && npm run test:desktop`
- Add focused coverage for conversation classification, including a
  ticket-backed session with no project association; sidebar partitioning;
  command-palette lookup; and the Overview onboarding-strip guard.

## Description


## Comments
