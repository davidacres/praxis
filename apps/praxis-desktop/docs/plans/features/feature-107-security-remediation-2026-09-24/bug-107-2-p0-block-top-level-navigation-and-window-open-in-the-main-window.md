# [P0] Block top-level navigation and window.open in the main window

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:51.539Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P0 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-002** (High, CWE-1188 chained with CWE-829) — `apps/praxis-desktop/main/src/main/index.ts:170-197` (the single `new BrowserWindow`); preload bridge at `apps/praxis-desktop/main/src/preload/index.ts:694`; the reachable sink at `apps/praxis-desktop/main/src/main/terminalIpc.ts:20-21`; the source at `apps/praxis-desktop/renderer/src/ui/Markdown.tsx:165`.

This item is the first half of SEC-002. Sender validation across every handler is tracked separately as *Validate the sender frame on every ipcMain handler*.

## Why this priority

High, and reachable from an untrusted boundary — model output. `will-navigate`, `will-redirect`, `setWindowOpenHandler` and `web-contents-created` appear nowhere outside `aiBrowser.ts` and `previewBrowser.ts`, so Electron's default applies: a top-level navigation proceeds and the preload re-attaches on the new document whatever its origin. That preload fronts 299 `ipcMain` registrations including `terminal:create` (spawns a login shell under a PTY) and `terminal:write` (arbitrary bytes into it). A prompt-injected agent emits an ordinary `[label](https://…)` link, the transcript renders it as a live anchor, and one click is enough. Child windows inherit the same `webPreferences`, and a `target="_blank"` link already exists at `DeploymentsPage.tsx:772`. This half is S and removes the exploit path outright.

## Change

In `apps/praxis-desktop/main/src/main/index.ts`, after the window is created (`:170-197`):

- Add `win.webContents.on('will-navigate', …)` and `('will-redirect', …)` that `preventDefault()` any URL whose origin is not the app's own — the `file://` renderer entry in a packaged build, or the dev-server origin, both already resolved in this file.
- Add `win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return { action: 'deny' }; })`, reusing the pattern already correct in `shellIpc.ts:11-15` and `aiBrowser.ts:122-130`.
- Add `sandbox: true` to `webPreferences` alongside the existing `contextIsolation: true, nodeIntegration: false`.
- Apply the same guards to any future window via `app.on('web-contents-created')` so this cannot regress by someone adding a second `BrowserWindow`.

## Verification

A Playwright spec under `apps/praxis-desktop/main/e2e` asserting that `window.location.assign('https://example.com')` leaves the window on the app origin, and that `window.open('https://example.com')` returns null with the app origin unchanged; plus an assertion that the created window's `webPreferences.sandbox` is true. Run `npm run test:desktop` (remember `npm run desktop:copy-renderer` first — the e2e suite depends on it).

## Effort

S

## Depends on

None.

## Risk

`sandbox: true` breaks a preload that uses Node built-ins. This one imports only `contextBridge` and `ipcRenderer` from `electron`, so it is safe — but confirm the bundled preload output does not inline a Node module. If any in-app flow navigates the main window (an OAuth redirect, a `praxis://` deep link, a docs link), the guard blocks it: allowlist the app origin and the `praxis:` scheme explicitly and re-test the MCP OAuth sign-in, which settles through a loopback and a `praxis://` path.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

