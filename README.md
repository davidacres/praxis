# Praxis

Praxis is a desktop app for working with tracked boards, issues, AI sessions, Git,
and delivery workflows from a single surface. It supports project- and
board-centric navigation, task design and execution planning, AI-assisted review
and implementation workflows, a native Git Graph and diff workspace, and multiple
backend types including Jira MCP, Demo, folder-backed markdown plans, and
GitLab-oriented delivery flows.

## Repository layout

An npm workspaces monorepo — the app in `apps/`, shared code in `packages/`:

```
apps/
└── praxis-desktop/
    ├── main/         Electron main + preload, e2e suite, packaging
    └── renderer/     React/Vite SPA — the app's UI

packages/
└── core/             shared types, stores, backend adapters, folder/plans
                      parser, AI gateway
```

```
   ┌──────────────────────┐
   │ packages/core        │   types, stores, parsers, AI/MCP plumbing
   │ @praxis/core         │
   └──────────▲───────────┘
              │ shared by
   ┌──────────┴───────────┐
   │ praxis-desktop/      │
   │ renderer (React SPA) │
   └──────────┬───────────┘
              │ vite build + copy-renderer
              ▼
   ┌──────────────────────┐  electron-builder  ┌────────────────────┐
   │ praxis-desktop/main  │ ─────────────────► │ branded installers │
   │ (Electron host)      │                    │ .dmg / setup.exe   │
   └──────────────────────┘                    └────────────────────┘
```

`@praxis/core` is imported by `main` directly and by `renderer` for types. Run
`npm install` once at the repo root; the workspaces share a hoisted
`node_modules/`.

## Workspace / project / connection model

- **Workspace** — a saved, shareable context (`.workspace.praxis.json`) that groups
  project and connection references without copying their data. The sidebar has a
  workspace switcher; the tree is scoped to the active workspace. Exported files
  carry a `schemaVersion` and the app versions that wrote them, and contain
  references only — never connection secrets.
- **Project** — the unit of planned work, with one board. Work items live either
  in app storage or as markdown plans in the project's folder.
- **Connection** — an external/system backend: Jira MCP, Demo, a folder of
  markdown plans, or a GitLab delivery host.

Desktop Settings → Startup includes **Reopen last workspace**, which restores the
last valid workspace and durable view. With no valid open workspace, Praxis shows
a full-window Getting Started experience for creating or opening one. Projects are
always created inside the open workspace; the first project becomes its default.

## Git workspace

Praxis includes a native Git Graph and diff workspace backed by the installed Git
executable. The Electron main process owns repository discovery and Git commands;
the sandboxed renderer receives typed commit, file, hunk, line, history, blame,
and conflict records through preload IPC. It supports working/staged/commit/ref
comparisons, Inline/Split/Hunk views, file/hunk/selected-line staging, confirmed
discard, branch and commit actions, stash workflows, and three-way conflict
resolution.

## Backend modes

| Mode | Value | Support |
| --- | --- | --- |
| Jira MCP | `jiracloud` | Primary hosted tracker. Backed by an external Jira MCP server. Board/issue operations, comments, transitions, linked-epic flows, delivery automation. |
| Demo | `demo` | Built-in sample data for development and demos. Off by default. |
| Folder | `folder` | Reads markdown feature plans from one or more folders on disk; can optionally create/update local issue files. |
| GitLab | `gitlab` | Connection and delivery/MR workflows; the issue/board model does not match Jira parity. |
| GitHub | `github` | Configuration surface only; no full board/issue backend yet. |

## Development

```bash
npm install
npm run build            # core -> renderer -> copy-renderer -> desktop
npm run build:core       # just the shared core (must precede the rest)
npm run build:renderer

npm run check-types      # every workspace

npm test                 # core + desktop
npm run test:core        # node:test
npm run test:desktop     # Playwright e2e (loads the pre-built renderer)
npm run test:desktop:git # gitService unit tests
```

The e2e suite loads the pre-built renderer from
`apps/praxis-desktop/main/renderer/`. A renderer change is invisible to e2e until
you rebuild **and** run `npm run desktop:copy-renderer`.

The "hand a ticket to an agent" flow has its own coverage. `aiCodingTask.spec.ts`
drives it end to end with a scripted ACP agent fixture — no model, part of the
normal suite. `aiLiveAgent.live.spec.ts` drives a real CLI agent against a real
model; it spends money, is excluded from every ordinary run, and needs an explicit
opt-in:

```bash
cd apps/praxis-desktop/main
PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent
```

Cross-provider handover (two signed-in CLIs, spends twice) is the same project:

```bash
cd apps/praxis-desktop/main
PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent e2e/aiLiveHandover.live.spec.ts
```

### Run the app

```bash
npm run app:demo:mac         # macOS, with demo fixture data
./scripts/run-app.sh --demo  # equivalent shell flag
```

Normal launches start without sample data.

### Build installers

```bash
# macOS
npm run app:build:mac        # compile app + prepare renderer (no electron-builder)
npm run app:installer:mac    # electron-builder -> apps/praxis-desktop/main/dist/ (*.dmg)

# Linux
npm run app:build:linux      # compile app + prepare renderer (no electron-builder)
npm run app:installer:linux  # electron-builder -> apps/praxis-desktop/main/dist/ (*.AppImage, *.deb)
# Or use the script directly:
./scripts/build-installer.sh --target linux      # AppImage + deb
./scripts/build-installer.sh --target appimage   # AppImage only
./scripts/build-installer.sh --target deb        # deb only

# Windows (PowerShell)
npm run app:build:win
npm run app:installer:win    # electron-builder -> apps/praxis-desktop/main/dist/ (*-setup.exe)
```

The macOS DMG, Linux packages, and Windows assisted installer share the app's warm charcoal, parchment, and terracotta visual language.

### Signing and updates

The app can check for updates (Settings surfaces the state; the main process
handles it in `src/main/autoUpdate.ts`), but only from a **packaged build with a
publish feed**. In development, and in any build made with `--publish never`,
`update:check` reports `unsupported` with the reason rather than failing
quietly.

Publishing is driven entirely by environment variables, so an unsigned local
build behaves exactly as it always did — electron-builder skips signing and
notarization when the credentials are absent:

| Variable | For |
| --- | --- |
| `GH_TOKEN` | uploading the release |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | the Developer ID certificate (macOS) or code-signing cert (Windows) |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarization |

```bash
npm run dist:mac:publish --workspace=@praxis/desktop-main
npm run dist:win:publish --workspace=@praxis/desktop-main
```

The update feed is explicitly pinned to `davidacres/praxis` in the desktop
package's electron-builder configuration. Release builds include the updater
manifests and blockmaps; macOS builds also include the ZIP consumed by
Squirrel.Mac alongside the user-facing DMG.

**macOS updates require a signed build.** Squirrel.Mac refuses unsigned
bundles, so an unsigned build can find an update but not install one — it
reports `available` with `canInstall: false` rather than pretending to apply
it. `build/entitlements.mac.plist` carries the hardened-runtime entitlements
Electron, node-pty, and the CLI agent subprocesses need.

## Known limitations

- GitHub mode is not yet a full issue/board backend.
- GitLab support is strongest around delivery/MR workflows.
- Task Designer website-preview nodes only show sites that permit iframe embedding.
- Some automation flows depend on correct Jira/GitLab credentials, workflow
  settings, tracked boards, and repository setup.
