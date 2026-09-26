---
**Status:** In Progress
**Created:** 2026-09-25T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-143
title: "Floating chat window"
status: In Progress
feature: FX-BF-045
updated: 2026-09-26
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

**2026-09-26 — implementation (Claude):** Implemented as designed:

- New `main/src/main/detachedChatWindow.ts`: an in-memory `Map<issueKey,
  BrowserWindow>` is the single authority for which conversations are
  floating. `openDetachedChat` creates a native-framed, always-on-top,
  resizable `BrowserWindow` loading the same renderer bundle at
  `?detachedSession=<issueKey>` (query on the dev-server URL, or Electron's
  `loadFile` `query` option in a packaged build); re-opening an already-open
  conversation focuses its window instead of creating a second one.
  `closeDetachedChat` (pop-in) and `closeAllDetachedChats` (main window
  closing, or app quit) both go through the window's native `close()`, so a
  `closed` listener is the one place state is cleaned up regardless of
  whether the user hit pop-in or the native `×`.
- Extracted the main window's existing navigation-guard logic (was private to
  `index.ts`) into `rendererNavigationGuard.ts` so the floating window gets
  the identical guard — no new-window navigation to anywhere but this app's
  own renderer, http(s)/mailto handed to the OS browser like the main window
  already does.
- Closing the main window now closes every floating window with it
  (`win.on('closed', () => closeAllDetachedChats())`): without this, macOS's
  dock "activate" only recreates a window when `getAllWindows().length ===
  0`, so a user who closed the main window while a conversation was floating
  would be stuck with only the small chat window and no way back into the
  app. Nothing is lost either way — a conversation is just a session, so it
  reappears in the next main window's Conversations list regardless.
- `detachedChat` IPC surface (`open`/`close`/`list`/`onChanged`) added to
  `preload/index.ts` and to core's `PraxisIpc`/`DetachedChatIpc` types.
- Renderer: `main.tsx` reads `?detachedSession=` and renders the new
  `ai/DetachedChatWindow.tsx` instead of `<App/>` — it loads the one session,
  subscribes to the existing `ai:sessionChanged`/`ai:sessionDeleted` push
  events (already broadcast to every `BrowserWindow`, so no new push channel
  was needed for the chat content itself), and renders it through the
  existing `SessionsPage` composer/transcript with a pop-in button in place
  of pop-out.
- `SessionsPage` gained optional `onPopOut`/`onPopIn` props rendered as
  header icon buttons (each with an `aria-label`, per this app's icon-button
  rule) — only wired for the Conversations console, so an ordinary
  ticket/board session shows neither. `App.tsx`'s `renderConversationsPage`
  tracks the main process's detached set (`detachedChat.list()` +
  `onChanged`) and swaps the live console for a "This conversation is open in
  its floating window" placeholder with a "Bring back to this window" button
  when the selected conversation is currently floating — so it is never
  rendered live in two windows at once.
- Position/size: the floating window remembers its last `getBounds()` across
  pop-outs within the same run (`lastBounds` in `detachedChatWindow.ts`).
  **Not persisted across a full app restart** — the story's own risk section
  only requires "no orphaned windows on quit/relaunch," which the in-memory
  registry already satisfies for free (nothing to reattach — the conversation
  is just back in the main window). If cross-restart bounds memory is wanted,
  that is a small follow-up (a couple of keys in the existing settings JSON),
  not implemented here since it wasn't in the story's acceptance criteria.

**Verification:** `npm run check-types`/`tsc -p .` clean across
`@praxis/core`, `@praxis/desktop-main` and `@praxis/desktop-renderer`;
`npm run build:core`, `build:renderer`, `build:desktop` and
`desktop:copy-renderer` all succeed; `npm run test:core` — 1312/1312 passing.

**`npm run test:desktop` could not be run in this sandbox** (same root cause
noted on FX-BE-142: Electron can't launch here because `node-pty` has no
linux-x64 prebuild and the container's network policy denies `nodejs.org`,
so node-gyp can't fetch headers to build one — unrelated to this change).
This story's acceptance criteria are the ones I could **not** verify by
running the app: the always-on-top/drag/resize behaviour on a real desktop,
exactly-one-live-subscription during an active stream through a pop-out/
pop-in cycle, and the quit/relaunch reachability check. The new e2e coverage
the story asks for (pop-out during an active stream, pop-in, native close,
quit/relaunch) was not authored, for the same reason as FX-BE-142 — I did not
want to hand over Playwright specs I had no way to run. Marking **In
Progress**, not **Done**, until someone runs
`npm run desktop:copy-renderer && npm run test:desktop` on a normal
dev machine, drives the pop-out/pop-in/native-close/quit-relaunch flow by
hand at least once, and ideally adds the missing spec file.
