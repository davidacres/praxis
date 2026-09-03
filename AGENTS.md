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

All confirmations, alerts, prompts, and destructive-action warnings must use
themed in-app UI. Never use native OS/browser dialogs such as `window.confirm`,
`window.alert`, or `window.prompt`; they do not match the Praxis visual system.

Do not put board or entity identity icons inside decorative bordered or filled
tiles solely to sit beside a title. Render identity icons directly on the themed
surface; reserve bordered icon containers for interactive controls or meaningful
status indicators.

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

## Keyboard focus

`theme.css` ends with a single global `:focus-visible` ring, last in the file so it wins on
source order against component `:focus` rules that only tint a border. **Do not add a bare
`outline: none`.** A component may add emphasis on focus, but anything that removes the ring
has to paint something equally visible in its place — otherwise the control simply cannot be
seen when focused, which is invisible in a screenshot and only hurts the people driving the
app from the keyboard. This eroded once already (26 outline resets against 15 `:focus-visible`
rules, while `:hover` was styled 91 times); `e2e/keyboardFocus.spec.ts` now tabs through the
shell and fails loudly if any control paints nothing.

## Dialogs

There is no `window.confirm` / `window.prompt` in the renderer. They are OS-modal,
unstyleable, ignore the app's themes, and block the renderer — and two of the prompts
collected real data with no validation. Use `useDialogs()` from `ui/dialogs.tsx` instead:
`await confirm({ title, message?, danger? })` and `await prompt({ title, label, validate? })`
render inside the app's own modal surface and return a promise, so a call site still reads
`if (!(await confirm(...))) return;`. `<DialogHost>` wraps `<App/>` in `main.tsx`. An e2e test
that used to accept a native dialog with `page.on('dialog', …)` now clicks the button in the
in-app dialog by its `confirmLabel`.

## Command palette

`⌘K` opens `app/CommandPalette.tsx` over a flat index built in `App` (`paletteEntries`) from
the collections the shell already holds — projects, boards, sessions, agents, skills,
workflows, feature destinations, settings pages. It is navigation only; each entry's `run`
reuses the same `navigate()` / `setSettingsDialogCategory()` the sidebar uses. Add a new
navigable surface → add an entry to that `useMemo`.

## Onboarding and the walkthrough

First run is: Getting Started's "Create your first project" (a default workspace is created
behind the scenes) → a three-panel wizard → the project dashboard, which carries a Get
Started strip while the project has no sessions. `praxis-onboarded` marks the profile past
Getting Started and shortens the splash; `praxis-walkthrough-seen` marks the tour done.

`app/Walkthrough.tsx` is a short, non-blocking tour that rings controls the shell already
renders — it annotates the user's real project rather than seeding a demo one. Stops are
declared in `App` (`walkthroughStops`) as CSS selectors over existing `data-testid`s; a stop
whose target is absent is skipped, not shown empty. Two invariants, both covered by
`e2e/walkthrough.spec.ts`: **the ring never takes pointer events** (the highlighted control
stays clickable), and **the ring must enclose the control the callout describes** — do not
add a CSS transition to the ring's geometry, which left it lagging a stop behind.

The ring is `3px dashed var(--tone-tour)`, a magenta used nowhere else in the chrome. Do not
put it back on the accent: that was a fourth meaning for a token already carrying brand and
primary action, it was indistinguishable from the `2px solid var(--focus-ring)` keyboard
ring, and it vanished when it landed on an accent button. An annotation must not look like a
control — the dashed style and the off-palette hue are both asserted.

## Settings
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
