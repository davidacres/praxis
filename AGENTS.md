# AGENTS.md

Guidance for AI coding agents working in this repository. This is the single
source; `CLAUDE.md` points here.

## Project Overview

A monorepo: the **Praxis** desktop app over a shared core.

| Workspace | npm name | What it is |
| --- | --- | --- |
| `packages/core` | `@praxis/core` | Shared types, settings, Git parsing, folder/plans parsing, AI/MCP plumbing. CommonJS. |
| `apps/praxis-desktop/renderer` | `@praxis/desktop-renderer` | The desktop renderer — React + Vite. Ordinary DOM. |
| `apps/praxis-desktop/main` | `@praxis/desktop-main` | Electron main + preload + the Playwright e2e suite. Hosts the renderer build. |

Core is consumed only by the Electron app (`main` directly, `renderer` for
types). It targets Node/Electron — no host-abstraction ports.

## Shared logic belongs in core

When both `main` and `renderer` need the same logic it lives in `packages/core`.
The renderer imports **types only** from core at runtime — core is CommonJS and
pulls in `chokidar` / `markdown-it`, so it cannot be tree-shaken into the browser
bundle (see the `settingsDefaults.ts` note below).

---

# Praxis desktop app (`apps/praxis-desktop/renderer` + `apps/praxis-desktop/main`)

Plain React in a normal DOM.

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

## Workspace / project / connection model

Three layers, each with one job:

- **Workspace** (`.workspace.praxis` file, `WorkspaceRecord`) — a saved, shareable set
  of project + connection references. Groups; owns no board data.
- **Project** (`ProjectRecord`, `ProjectStore`) — the unit of planned work. One board.
  `storage: 'app'` keeps work items in app JSON; `storage: 'folder'` backs them with a
  markdown plans folder under `project.workspaceFolder`. Synthetic connection id
  `project:<id>`, `mode: 'project'`.
- **Connection** (`Connection`, `connectionStore`) — an external/system backend.
  `mode ∈ { jiracloud | gitlab | github | demo | folder }`. `folder` points at one or
  more plans-folder roots on disk (native multi-root; each root's `board.praxis.json`
  carries its own `projectKey` / `projectName`).

## Build and test

Root scripts are prefixed by the surface they act on. `build` and `test` with no
prefix run **everything**, in dependency order.

```bash
npm run build          # core -> renderer -> copy-renderer -> desktop
npm run test           # test:core, test:desktop
npm run check-types    # every workspace

# or one surface at a time
npm run build:core     # must precede the others: they consume its emitted types
npm run build:renderer
npm run desktop:copy-renderer   # REQUIRED before e2e
npm run build:desktop

npm run test:core             # node:test
npm run test:desktop          # Playwright e2e
npm run test:desktop:git      # gitService unit tests
```

**The e2e suite loads the pre-built renderer** from `apps/praxis-desktop/main/renderer/`, not
a dev server. A frontend change is invisible to e2e until you rebuild **and** run
`copy-renderer`.

Visual changes will move Playwright snapshots. Regenerate with `--update-snapshots`, then
**look at the regenerated PNGs** before accepting them.
