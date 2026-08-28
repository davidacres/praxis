# AGENTS.md

Guidance for AI coding agents working in this repository. This is the single
source; `CLAUDE.md` points here.

## Project Overview

A monorepo with **two front-ends over one shared core**:

| Workspace | npm name | What it is |
| --- | --- | --- |
| `packages/core` | `@praxis/core` | Shared types, settings, Git parsing, AI/MCP plumbing. CommonJS. Consumed by both surfaces. |
| `apps/vscode-extension` | `praxis` | The VS Code extension. Renders its UI as **webview panels**. |
| `apps/praxis-desktop/renderer` | `@praxis/desktop-renderer` | The **Praxis** desktop renderer — React + Vite. Ordinary DOM, no webviews. |
| `apps/praxis-desktop/main` | `@praxis/desktop-main` | Electron main + preload + the Playwright e2e suite. Hosts the renderer build. |

The extension's npm name is `praxis`, not `@praxis/*`, and must stay that
way: with publisher `davidacres` it forms the marketplace ID
`davidacres.praxis`. Renaming it orphans the extension for everyone who
already has it installed.

The two UI surfaces share `core` but **share no UI code and no CSS**. Rules below
are labelled with the surface they apply to — applying a webview rule inside the
Electron renderer (or the reverse) is a common and costly mistake.

## Shared logic belongs in core

The extension used to carry ~50 copies of modules core already owned — shims,
byte-identical duplicates, and files that had silently drifted apart, including
a ~2,600-line fork of the whole live-folder parser. Those are all gone. When
both surfaces need the same logic it lives in `packages/core`, stays
host-agnostic, and each surface supplies its own bindings through an adapter in
`apps/vscode-extension/src/adapters/`.

Where core needs a host capability it can't assume — VS Code's `Memento`,
`workspace.fs`, a file watcher — it exposes a small port with a `node:fs`-style
default and a `setX()` swap (`setLiveFolderFs`, `setLiveFolderWatch`,
`setMcpOAuthProviderSource`). The extension calls those in `activate()`; the
desktop app takes the defaults. Add a host capability the same way rather than
forking a module.

---

# VS Code extension (`apps/vscode-extension`)

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

# Praxis desktop app (`apps/praxis-desktop/renderer` + `apps/praxis-desktop/main`)

Plain React in a normal DOM. **None of the webview rules above apply here** — there is
no `createWebviewPanel`, no injected body padding, and no `--vscode-*` tokens.

`renderer/src` is grouped by feature. Put a new file in the folder that owns its
screen; only genuinely cross-cutting primitives belong in `ui/`.

```
renderer/src/
├── app/            shell: App, Sidebar, TitleBar, BottomPanel, splash
├── projects/       project home, workspace, wizard, work mode
├── board/          board view, filter bar, board preferences
├── issues/         issue detail, new issue, peek, analysis
├── git/            graph, diff workspace, conflict workspace
├── ai/             sessions, model manager, review pages, workflow picker
├── settings/       SettingsPage, themes, surfacePacks, surfacePatterns
├── taskDesigner/   task designer page, sidebar, state
├── connections/    connection + board setup
├── ui/             shared primitives (Icon, Markdown, form controls)
├── assets/         images and generated texture tiles
├── main.tsx        vite entry — stays at the root
└── theme.css, surfaces.css
```

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
  `npm run textures --workspace=@praxis/desktop-renderer` (renders through Electron's
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

`apps/praxis-desktop/renderer/index.html` carries the CSP, and it **must** keep `img-src 'self' data:`.
The surface pattern and grain layers are inline SVG / data tiles; without that directive
they compute correctly but silently never paint — a failure that looks like a styling bug
and is genuinely hard to trace. An e2e test decodes a live tile through `Image()` to catch
a regression loudly.

## Settings

- One shared JSON document, read through `sanitizeAppSettings` (which also migrates) and
  merged with `mergeAppSettings`. IPC: `settings.get` / `settings.set` / `settings.onChanged`.
- **`apps/praxis-desktop/renderer/src/settings/settingsDefaults.ts` is a hand-maintained, browser-safe mirror
  of core's `DEFAULT_APP_SETTINGS`.** Core is CommonJS and pulls in `chokidar` and
  `markdown-it`, so it cannot be tree-shaken into the renderer bundle. **Add an appearance
  field to core and you must add it here too**, or the Settings page silently drifts from
  what the main process sees.
- Anything from settings that ends up baked into CSS (a colour, a blend mode) must be
  validated to a strict literal in core — a hex, or a keyword from a fixed set. Never pass
  user text through into a stylesheet.

## Build and test

Root scripts are prefixed by the surface they act on. `build` and `test` with no
prefix run **everything**, in dependency order.

```bash
npm run build          # core -> renderer -> copy-renderer -> desktop -> vscode
npm run test           # test:core, test:desktop, test:vscode
npm run check-types    # every workspace

# or one surface at a time
npm run build:core     # must precede the others: they consume its emitted types
npm run build:renderer
npm run desktop:copy-renderer   # REQUIRED before e2e
npm run build:desktop

npm run test:core             # node:test
npm run test:desktop          # Playwright e2e
npm run test:desktop:git      # gitService unit tests
npm run test:vscode           # launches a real VS Code (see caveat below)
```

`npm run test:vscode` cannot run everywhere. `@vscode/test-cli` downloads VS Code
and spawns a binary named `Electron`, but recent macOS arm64 builds ship theirs as
`Code`. Symlinking gets past the spawn and the process is then SIGKILLed, because
substituting the binary invalidates the bundle's code signature. Treat a green
typecheck plus a clean esbuild bundle as the local signal, and rely on CI for the
integration suite.

**The e2e suite loads the pre-built renderer** from `apps/praxis-desktop/main/renderer/`, not
a dev server. A frontend change is invisible to e2e until you rebuild **and** run
`copy-renderer`.

Visual changes will move Playwright snapshots. Regenerate with `--update-snapshots`, then
**look at the regenerated PNGs** before accepting them.
