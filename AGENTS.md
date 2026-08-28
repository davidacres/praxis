# AGENTS.md

Guidance for AI coding agents working in this repository. This is the single
source; `CLAUDE.md` points here.

## Project Overview

A monorepo with **two front-ends over one shared core**:

| Package | What it is |
| --- | --- |
| `packages/core` | Shared types, settings, Git parsing, AI/MCP plumbing. CommonJS. Consumed by every other package. |
| `packages/vscode-extension` | The VS Code extension (`ticket-manager`). Renders its UI as **webview panels**. |
| `packages/frontend` | The **Praxis** desktop renderer — React + Vite. Ordinary DOM, no webviews. |
| `packages/electron-app` | Electron main + preload + the Playwright e2e suite. Hosts the frontend build. |
| `packages/pty-host` | Terminal host process. |

The two UI surfaces share `core` but **share no UI code and no CSS**. Rules below
are labelled with the surface they apply to — applying a webview rule inside the
Electron renderer (or the reverse) is a common and costly mistake.

---

# VS Code extension (`packages/vscode-extension`)

## Webview Panel Rules

**CRITICAL: VS Code Insiders webview rendering requirement**

When creating webview panels (`createWebviewPanel`), `panel.webview.html` MUST be set
synchronously — in the same execution block — immediately after panel creation. Any `await`
between `createWebviewPanel()` and the `webview.html` assignment will cause the webview to
render blank in VS Code Insiders.

Wrong:
```typescript
const panel = vscode.window.createWebviewPanel(...);
await fetchData();              // async gap breaks rendering in Insiders
panel.webview.html = getHtml(); // too late — blank forever
```

Right:
```typescript
await fetchData();              // fetch data first
const panel = vscode.window.createWebviewPanel(...);
panel.webview.html = getHtml(); // set immediately — works
```

If a panel needs to be refreshed with new data, dispose the old panel and create a new one
rather than setting `webview.html` on an existing panel after an async operation. See
`IssueDetailPanelManager.createPanelWithHtml()` and `refreshIfShowing()` for the pattern.

**CSP pattern**: All webview panels should use:
```
default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';
```
Use `<style>` without a nonce attribute, and `<script nonce="${nonce}">` for scripts.

**IMPORTANT: Script runtime scope**

Code inside `<script nonce="...">` runs in the webview browser context and cannot call
TypeScript helper functions declared in the extension host file scope.

If script code needs helper logic (for example color/format utilities used by `renderNodes`),
define that logic inside the webview script block (or serialize required values) rather than
calling host-scope functions directly.

Regression note:
- Calling host-only helpers from webview script previously caused runtime errors that broke node
	rendering and ticket add flows in Task Designer.

## Webview Layout Rules

**CRITICAL: Remove VS Code's default body padding to avoid the black left/right gutter**

VS Code injects a default `body { padding: 0 20px }` into every webview. Any panel whose CSS
does not override it shows a black gutter (the editor background) down the left and right edges,
pushing all content inward. This was reported as "extra margin" / "black area on the left and
right" of the board and other custom panes.

**Rule:** Every webview's `body` rule MUST explicitly set `padding: 0`. Do not rely on
`margin: 0` — that does not remove the injected padding. Control all spacing yourself from an
inner container, never from the default body padding.

Wrong (inherits the ~20px gutter):
```css
body { margin: 0; display: flex; }
```

Right (no gutter; spacing owned by inner containers):
```css
body { margin: 0; padding: 0; display: flex; }
```

**Canonical full-pane layout (rounded panel)**

The board (`boardPanelManager`), Issue Detail (`issueDetailPanelManager`) and Local Peer Review
(`localPeerReviewPanel`) panes share one layout. Reuse it for any new full-pane screen so they
stay visually consistent:

```css
body { margin: 0; padding: 0; /* removes the injected gutter */ }

.page {                 /* outer frame: thin even margin around the panel */
  box-sizing: border-box;
  display: flex;
  flex: 1;
  width: 100%;
  min-height: 100vh;
  padding: 8px;
}

.panel-shell {          /* the rounded-corner panel */
  box-sizing: border-box;
  display: flex;
  flex: 1;
  flex-direction: column;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  background: var(--vscode-sideBar-background);
  overflow: hidden;
}

.header, .content { padding: 16px; }   /* inner spacing lives here, not on body */
```

Notes:
- For an edge-to-edge canvas (e.g. Task Designer) still set `body { padding: 0 }`, but use a
  full-bleed root (`.shell { width: 100%; height: 100% }`) instead of the `.page` frame.
- The visible spacing of a pane is `body(0) + .page padding + .panel-shell border + inner
  padding`. To bring content closer to the edge, reduce `.page` padding — do NOT reintroduce
  body padding.
- Card/column styling inside the panel is independent of this frame; changing the frame must not
  alter card colors.

---

# Praxis desktop app (`packages/frontend` + `packages/electron-app`)

Plain React in a normal DOM. **None of the webview rules above apply here** — there is
no `createWebviewPanel`, no injected body padding, and no `--vscode-*` tokens.

## Theming

Four independent attribute axes on `<html>`, all composing:

| Attribute | Meaning |
| --- | --- |
| `data-mode` | `light` / `dark` — the surface + text ramp |
| `data-accent` | the single accent hue |
| `data-theme` | a complete named palette (`praxis-dark`, `github-light`, …) |
| `data-surface` | the **material** layer (`flat`, `parchment`, `graphite`, …) |

**Components only ever read tokens** (`--bg`, `--text`, `--accent`, `--border`, …). A
theme redefines those tokens per `[data-theme]` / `[data-mode]` block; never hard-code a
colour in a component.

A **surface pack sets only `--surface-*` properties** — never a colour token. That is
exactly what lets any pack compose with any palette.

## Surface packs and motifs

- **Patterns are data, not CSS.** `surfacePatterns.ts` holds the tile library; a pack
  references one by id and `applySurfacePack` renders it into `--surface-watermark-*`.
  Adding a material means **adding a library entry — never a new `[data-surface]`
  block**, and never a change to the panes.
- **Texture tiles are generated, not hand-authored.** Run
  `npm run textures --workspace=@ticket-manager/frontend` (renders through Electron's
  own Chromium into `src/assets/surfaces/`). Do not hand-edit the `.webp` files.
- **A pattern's colour is baked into an SVG `data:` URI**, so it cannot follow a `var()`.
  It must be re-baked whenever the palette changes — see `refreshSurfacePattern`, wired
  to the `tm-theme-changed` event.
- **Grain and motif layers sit BEHIND pane content** (`::before` / `::after` at
  `z-index: 0`, with the panes' direct children lifted to `z-index: 1`). That is what
  lets a material be strong without ever eroding text contrast. Keep it that way.
- A motif's declared strength is **perceptually normalised** against how far its ink sits
  from the panel, so one value reads the same on every palette. Tune the declared value,
  not the correction.
- `flat` must stay a **byte-for-byte no-op** — every `--surface-*` token is declared inert
  on `:root`, so an unset surface costs nothing.

## Renderer CSP

`packages/frontend/index.html` carries the CSP, and it **must** keep `img-src 'self' data:`.
The surface pattern and grain layers are inline SVG / data tiles; without that directive
they compute correctly but silently never paint — a failure that looks like a styling bug
and is genuinely hard to trace. An e2e test decodes a live tile through `Image()` to catch
a regression loudly.

## Settings

- One shared JSON document, read through `sanitizeAppSettings` (which also migrates) and
  merged with `mergeAppSettings`. IPC: `settings.get` / `settings.set` / `settings.onChanged`.
- **`packages/frontend/src/settingsDefaults.ts` is a hand-maintained, browser-safe mirror
  of core's `DEFAULT_APP_SETTINGS`.** Core is CommonJS and pulls in `chokidar` and
  `markdown-it`, so it cannot be tree-shaken into the renderer bundle. **Add an appearance
  field to core and you must add it here too**, or the Settings page silently drifts from
  what the main process sees.
- Anything from settings that ends up baked into CSS (a colour, a blend mode) must be
  validated to a strict literal in core — a hex, or a keyword from a fixed set. Never pass
  user text through into a stylesheet.

## Build and test

```bash
# core must be rebuilt before other packages see its type changes
npm run compile --workspace=@ticket-manager/core

npm run build --workspace=@ticket-manager/frontend
npm run copy-renderer --workspace=@ticket-manager/electron-app   # REQUIRED before e2e
npm run compile --workspace=@ticket-manager/electron-app

npm test --workspace=@ticket-manager/core                        # node:test
cd packages/electron-app && npx playwright test                  # e2e
```

**The e2e suite loads the pre-built renderer** from `packages/electron-app/renderer/`, not
a dev server. A frontend change is invisible to e2e until you rebuild **and** run
`copy-renderer`.

Visual changes will move Playwright snapshots. Regenerate with `--update-snapshots`, then
**look at the regenerated PNGs** before accepting them.
