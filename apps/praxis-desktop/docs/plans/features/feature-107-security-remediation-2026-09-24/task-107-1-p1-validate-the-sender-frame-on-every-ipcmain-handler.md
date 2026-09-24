# [P1] Validate the sender frame on every ipcMain handler

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:54.431Z
**Type:** Task
**Priority:** Medium
**Parent:** PRX-F107

## Description
**Priority:** P1 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-002** (High, CWE-1188) — the third remediation layer: `apps/praxis-desktop/main/src/main/terminalIpc.ts:20-21` and the other 297 registrations across `apps/praxis-desktop/main/src/main`; preload bridge at `apps/praxis-desktop/main/src/preload/index.ts:694`.

The navigation guard that closes the live exploit path is the companion item, *Block top-level navigation and window.open in the main window*.

## Why this priority

P1 rather than P0 because once navigation is blocked the exploit is closed; this is the control that stops the *next* navigation bug from being equivalent to RCE. None of the 299 handlers inspects `event.senderFrame` — the five files that touch `event.sender` use it only to resolve `BrowserWindow.fromWebContents` — so any document that ever gets the preload attached holds the full bridge. M effort because it touches every IPC registration file.

## Change

- Add a shared helper (for example `apps/praxis-desktop/main/src/main/ipcSender.ts`) exporting `assertTrustedSender(event)`, comparing `event.senderFrame.url` against the app's own origin — the packaged `file://` renderer entry or the dev-server origin — and throwing otherwise.
- Prefer a registration wrapper (`registerHandler(channel, fn)` / `registerListener(channel, fn)`) over 299 hand-edits, so every new channel is covered by construction. Migrate the highest-value modules first: `terminalIpc.ts`, `aiIpc.ts`, `shellIpc.ts`, then the mobile and workflow IPC modules, then the rest.

## Verification

A repo check script that fails the build if any `ipcMain.handle` or `ipcMain.on` registration is made outside the wrapper — `apps/praxis-desktop/renderer/scripts/checkCoreImports.cjs` (wired into that workspace's `check-types` as `check-core-imports`) is the existing precedent for this kind of enforced invariant. Plus a desktop test asserting a handler invoked from a non-app frame is rejected. Run `npm run test:desktop` and `npm run check-types`.

## Effort

M

## Depends on

Block top-level navigation and window.open in the main window

## Risk

A mechanical edit across 299 call sites is where regressions hide. An over-strict origin comparison breaks IPC for the entire renderer, and packaged (`file://`) and dev-server origins differ — get both right before enforcing. Legitimate secondary frames (the AI browser and preview views, devtools) must be considered. Roll the wrapper out in log-only mode first, watch for unexpected origins, then switch it to throw.

## Dependencies


## Comments

