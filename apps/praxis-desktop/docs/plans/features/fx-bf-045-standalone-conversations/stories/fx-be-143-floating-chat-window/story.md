---
**Status:** Backlog
**Created:** 2026-09-25T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-143
title: "Floating chat window"
status: Backlog
feature: FX-BF-045
updated: 2026-09-25
dependencies: [FX-BE-142]
---

# FX-BE-143: Floating chat window

## User or operational impact

Lets a user keep chatting with the AI in a small window that stays on top
while they work in other apps, instead of the conversation being trapped
inside the main Praxis window.

## Scope

- Pop-out action, placed in the conversation's own header/toolbar (not the
  sidebar row — "float this out" is an action taken while looking at the
  content, keeping the sidebar row's hover actions limited to
  rename/archive/delete), opens a second **native-framed** `BrowserWindow`:
  always-on-top, resizable, user-draggable, loading the same renderer bundle
  at a route such as `?detachedSession=<issueKey>`. Native framing is
  intentional: it supplies a platform-native close control. This is the
  app's first window beyond the single `createMainWindow` instance
  (`main/src/main/index.ts:216`). It inherits the renderer's existing CSP
  automatically (a static `<meta>` tag in `renderer/index.html`, not
  per-window config) but needs its own navigation guard and
  `windowOpenHandler`, mirroring `attachMainWindowNavigationGuard`.
- Main process ownership is explicit: a `detachedSessionKey` registry is the
  authority for detached-window state and the sole live stream subscription
  target. IPC commands cover pop-out, pop-in, and native window close. The
  detached renderer boots from `detachedSession=<issueKey>` and subscribes
  only after registration succeeds.
- While a conversation is floating, the main window shows it as "open in
  floating window" rather than rendering the chat twice. Pop-out unregisters
  the main-window surface before registering the detached surface; pop-in or
  native close clears the registry, closes the detached window, and reselects
  the conversation in the main window. It never discards the chat.
- Floating window position and size are remembered across pop-outs.
- No orphaned floating windows: quitting and relaunching the app always
  leaves every conversation reachable from the main window's Conversations
  list, never stuck in a window that no longer exists.
- Pop-out and pop-in are icon-only buttons; each needs an `aria-label`
  (`ui/iconButtonTooltips.ts` copies it into the hover tooltip — a control
  with no visible text needs this to have an accessible name at all).

## Acceptance criteria

- Popping out a conversation opens a window that stays on top of other
  applications, can be dragged and resized, and keeps streaming/chatting
  without interruption.
- Closing the floating window (via its pop-in button or its [x]) returns the
  conversation to the main window with its full history intact — nothing is
  lost.
- The same conversation is never rendered live in both the main window and
  the floating window at once.
- Relaunching the app after it was closed with a conversation floating shows
  that conversation back in the main window's Conversations list, not stuck
  or missing.
- The pop-out and pop-in buttons each have a visible tooltip/accessible name
  despite carrying no text.

## Validation

- `npm run check-types`
- `npm run build`
- `npm run test:desktop`
- Add desktop e2e coverage for pop-out during an active stream, pop-in, native
  close, and app quit/relaunch. Assert that exactly one renderer receives the
  conversation's live update subscription at each lifecycle transition.

## Description


## Comments
