---
**Status:** 🔄 In Progress
**Created:** 2026-09-26T00:20:35.000Z
**Type:** Task
**Priority:** High
id: TASK-374
title: Verify the floating chat window in a running app and add its e2e coverage
status: To Do
story: FX-BE-143
updated: 2026-09-26
dependencies: [TASK-373]
validation: [npm run check-types, npm run build, npm run desktop:copy-renderer, npm run test:desktop]
---

# TASK-374: Verify the floating chat window in a running app and add its e2e coverage

## Goal

FX-BE-143's implementation (`detachedChatWindow.ts`'s second `BrowserWindow`,
the shared `rendererNavigationGuard.ts`, the `detachedChat` IPC surface,
`DetachedChatWindow.tsx`, and the pop-out/pop-in buttons + "open in floating
window" placeholder in `App.tsx`/`SessionsPage.tsx`) was written and
type-checked/built clean, but this is the app's first window beyond the
single main one and was never actually opened, dragged, resized, or closed
on a real desktop — the implementing session could not launch Electron in
its sandbox at all (see TASK-373). This is the higher-risk of the two
stories: it needs hands-on verification of real OS window behaviour, not
just a passing assertion.

## Done when

- Manually verified in the running app, per FX-BE-143's acceptance criteria:
  - Popping out a conversation opens a window that stays on top of other
    applications, can be dragged and resized, and keeps
    streaming/chatting without interruption — verify this specifically
    while a turn is actively streaming, not only on an idle session.
  - Closing the floating window via its pop-in button, and separately via
    its native `×`, both return the conversation to the main window with
    full history intact.
  - The same conversation is never rendered live in both windows at once —
    watch the main window switch to the "open in floating window"
    placeholder the instant the window opens, and back the instant it
    closes.
  - Quitting the app with a conversation floating, then relaunching, shows
    that conversation back in the main window's Conversations list — never
    stuck in a window that no longer exists.
  - Closing the *main* window while a conversation is floating closes the
    floating window with it (this repo's own fix for the "user is stuck
    with only a small chat window and no way back into the app" failure
    mode) — confirm this on at least macOS or Windows, where `activate`
    behaviour differs from Linux.
  - Both pop-out and pop-in buttons show a tooltip on hover (their
    `aria-label`, per `iconButtonTooltips.ts`) despite carrying no text.
- New Playwright coverage added and green in `npm run test:desktop`, per
  FX-BE-143's own Validation section: pop-out during an active stream,
  pop-in, native close, and app quit/relaunch, asserting that exactly one
  renderer receives the conversation's live update subscription at each
  lifecycle transition.
- Decide and implement (or explicitly defer as its own follow-up) whether
  the floating window's position/size should be remembered across a full
  app restart, not just across pop-outs within one run — the current
  implementation only does the latter (`lastBounds` is in-memory), which
  satisfies the story's written acceptance criteria but is worth a
  deliberate call rather than an oversight.

## Description


## Dependencies

FX-BE-143, TASK-373


## Comments
