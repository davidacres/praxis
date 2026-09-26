---
**Status:** 🔄 In Progress
**Created:** 2026-09-26T00:20:35.000Z
**Type:** Task
**Priority:** High
id: TASK-373
title: Verify Conversations list/lifecycle in a running app and add its e2e coverage
status: To Do
story: FX-BE-142
updated: 2026-09-26
dependencies: []
validation: [npm run check-types, npm run build, npm run desktop:copy-renderer, npm run test:desktop]
---

# TASK-373: Verify Conversations list/lifecycle in a running app and add its e2e coverage

## Goal

FX-BE-142's implementation (the `isConversationSession` predicate, the
Conversations sidebar node, the lightweight "New conversation" composer, the
Overview hero button/panel, the command palette entries, and the
starter-strip gating fix) was written and type-checked/built clean, but was
never run in an actual Electron window or exercised by Playwright — the
session that implemented it could not launch Electron in its sandbox
(`node-pty` has no linux-x64 prebuild there and the container's network
policy blocked fetching the headers to build one). This task closes that
verification gap on a machine that can actually run the app.

## Done when

- `npm run build && npm run desktop:copy-renderer` succeeds and `npm start`
  (or the packaged app) launches without error.
- Manually verified in the running app, per FX-BE-142's acceptance criteria:
  - A conversation created from the sidebar `+` and from the Overview hero
    button appears under **Conversations** immediately, regardless of the
    selected project/workspace, and never under **Sessions**.
  - Archiving a conversation removes it from the active list but it is still
    reachable; deleting removes it for good after confirmation.
  - The conversation view uses the same composer/message UI as a session,
    with no ticket or board chrome anywhere.
  - A conversation is findable by name in the command palette (⌘K).
  - Starting a conversation as the very first action, before any project
    exists, still leaves the "Start here" onboarding strip visible on
    Overview.
  - Conversation list and history persist across an app restart.
  - A ticket-backed session with no `projectId` stays under **Sessions**,
    never **Conversations** (the one case that could regress silently if the
    classification predicate is ever loosened).
- New Playwright coverage added and green in `npm run test:desktop` for the
  above, per FX-BE-142's own Validation section — at minimum:
  - Conversation classification (a free-form session vs. a ticket-backed
    session with no project vs. a workflow-stage session).
  - Sidebar partitioning (Conversations vs. Sessions never double-list the
    same session).
  - Command-palette lookup of a conversation by title.
  - The Overview onboarding-strip guard with a conversation started first.
- Existing specs re-run and still green, since this feature touched shared
  code paths: `overview.spec.ts`, `commandPalette.spec.ts`,
  `sidebarTreeAlignment.spec.ts`, `aiSessions.spec.ts`.
- Any screenshot-backed assertions re-baselined only after opening the
  `-actual.png`/diff and confirming the change is the fix, not a regression
  (per this repo's "Verifying a UI change" rule).

## Description


## Dependencies

FX-BE-142


## Comments
