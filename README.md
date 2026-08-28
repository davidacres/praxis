# Praxis

Praxis is a VS Code extension for working with tracked boards, issues, AI sessions, and delivery workflows from a single extension surface.

It supports classic multi-view navigation, a board-centric Work Mode, task design and execution planning, AI-assisted review and implementation workflows, and multiple backend types including Jira MCP, Demo, Live Folder, GitLab-oriented delivery flows, and local workspace-backed storage.

Current extension version: 0.0.30

## Repository layout

The project is an npm workspaces monorepo. Two products sit in `apps/`, and the
code they share sits in `packages/`:

```
apps/
├── praxis-desktop/
│   ├── main/              Electron main + preload, e2e suite, packaging
│   └── renderer/          React/Vite SPA — the desktop app's UI
└── vscode-extension/      the VS Code extension (this README's main subject)

packages/
└── core/                  shared types, stores, backend adapters, AI gateway
```

```
                     ┌──────────────────────┐
                     │ packages/core        │
                     │ @praxis/core         │
                     └──────▲────────▲──────┘
                  shared by │        │ shared by
              ┌─────────────┘        └─────────────┐
              │                                    │
   ┌──────────┴────────────┐          ┌────────────┴──────────┐
   │ praxis-desktop/       │          │ vscode-extension      │
   │ renderer  (React SPA) │          │ (webview panels)      │
   └──────────┬────────────┘          └───────────────────────┘
              │ vite build + copy-renderer
              ▼
   ┌───────────────────────┐  electron-builder  ┌────────────────────┐
   │ praxis-desktop/main   │ ─────────────────► │ branded installers │
   │ (Electron host)       │                    │ .dmg / setup.exe   │
   └───────────────────────┘                    └────────────────────┘
```

The extension is published as `davidacres.praxis`, so its npm name stays
`praxis` rather than moving under the `@praxis` scope.

Build the Praxis desktop installer with `npm run app:dist:mac` on macOS or
`npm run app:dist:win` on Windows. Artifacts are written to
`apps/praxis-desktop/main/dist/`. The macOS DMG and Windows assisted installer use
the same warm charcoal, parchment, and terracotta visual language as the app.

### Praxis desktop Git workspace

Praxis includes a native Git Graph and diff workspace backed by the installed
Git executable. The Electron main process owns repository discovery and Git
commands; the sandboxed renderer receives typed commit, file, hunk, line,
history, blame, and conflict records through preload IPC.

The desktop workflow supports working/staged/commit/ref comparisons, Inline,
Split, and Hunk views, file/hunk/selected-line staging, confirmed discard,
branch and commit actions, stash workflows, and three-way conflict resolution.
Focused evidence is captured under `apps/praxis-desktop/main/output/playwright/`.

### Praxis desktop saved workspaces

The sidebar has a workspace switcher above the project tree. A workspace is a
named context that groups project references without copying project data; the
tree is scoped to the active workspace. Workspaces can be created, switched,
saved to a portable `.praxis-workspace.json` file, and re-opened. Exported files
carry a `schemaVersion` and the Praxis versions that created and last saved them,
and contain references only — never connection secrets.

`@praxis/core` is the only package imported by both UIs. Each shell has its own React components and CSS — components in `vscode-extension/src/views/` are not reused by `frontend/src/`. Run `npm install` once at the repo root; the four workspaces share a hoisted `node_modules/`.

## What the extension includes

- Connections & Boards management for multi-connection setups.
- Two sidebar layouts:
	- Classic mode with Boards, EPICs, My Issues, Sessions, and Issue Details views.
	- Work Mode with a board-centric view that nests active AI sessions under boards.
- Board browsing, tracked-board selection, board filtering, and board display customization.
- Board settings for unified status editing, per-status colors, swim lanes, filters, and per-ticket-type board colors.
- Issue workflows including create, edit, transition, comment, assign-to-me, assign-to-AI, and open-in-browser flows.
- AI session management for Copilot, Claude, OpenAI, and CLI-backed agent providers.
- Local Peer Review (LPR) for issue-focused review output.
- Task Designer for planning execution with ticket nodes, note nodes, website preview nodes, curved connectors, zoom, AI recommendations, and master-plan generation.
- Live Folder markdown import/migration helpers.
- Jira MCP-backed delivery workflow orchestration, including worktree-backed delivery flows and sub-task delivery support.

## Main UI surfaces

### Activity bar containers

- Tickets
- Work Mode

### Classic mode views

- Configure Project
- Boards
- EPICs
- My Issues
- Sessions
- Issue Details

### Work Mode views

- Configure Project
- Work Mode

### Other panels

- Connections & Boards
- Task Designer
- Local Peer Review
- Full Issue Details panel
- Copilot / AI session panel

## Backend modes

Configured through `praxis.backendMode` and, for tracked boards, through the per-connection mode stored in `praxis.connections`.

| Mode | Value | Current support |
| --- | --- | --- |
| Jira MCP | `jiracloud` | Primary hosted tracker mode. Backed by an external Jira MCP server (`atlassian-jira_*` or `mcp_com_atlassian_*`). Supports board and issue operations, comments, transitions, linked-epic flows, and delivery automation. |
| Demo | `demo` | Built-in sample data for extension development and demos. |
| GitHub | `github` | Configuration surface exists, but full board/issue parity with Jira is not implemented. |
| GitLab | `gitlab` | Connection and delivery/MR workflows exist, but the issue/board model does not match Jira parity. |
| Live Folder | `livefolder` | Reads markdown feature plans from disk and can optionally create/update local issue files. |
| User Workspace | `userworkspace` | Uses local workspace-backed issue storage for lightweight local workflows. |

## Task Designer

The Task Designer is the extension's visual planning surface.

It currently supports:

- Ticket nodes added from tracked issues.
- Note nodes for free-form planning text.
- Website preview nodes with an editable URL and a live embedded preview.
- Drag-and-drop issue placement from the issue/board surfaces.
- Directed curved connectors with explicit edge handles.
- Connector selection and delete support.
- Mixed-node persistence and recovery.
- Zoom in and zoom out controls.
- AI recommendation flows for ticket nodes.
- Master plan generation from the designed execution graph.

Notes:

- Website previews depend on the target website allowing iframe embedding. Sites that block framing with their own headers or CSP may not render inside the preview component.
- AI recommendation and master-plan flows operate on ticket nodes; note and website nodes are preserved on the canvas but are not part of the execution-plan graph.

## AI and delivery workflows

Praxis includes several AI-related surfaces:

- Assigning issues to configured AI providers.
- Viewing and managing AI sessions from the Sessions view.
- Starting Claude Code sessions.
- Delegating work to a Copilot agent workflow.
- Local Peer Review for implementation-focused review output.
- Jira MCP-driven delivery workflows (readiness analysis + delivery automation are launched by the AI agent when the user delegates a ticket).
- Delivery workflow configuration for worktree-backed implementation, publish command execution, artifact matching, and Jira summary/failure templates.
- Sub-task delivery initiation for feature decomposition flows.

## Commands and settings

The extension contributes a large command and settings surface. Use these docs as the authoritative references:

- [docs/user-guide.md](docs/user-guide.md): feature walkthrough plus grouped command reference.
- [docs/command-reference.md](docs/command-reference.md): dedicated user-facing command catalog.
- [docs/settings-reference.md](docs/settings-reference.md): shipped settings grouped by area.
- [docs/screenshots/README.md](docs/screenshots/README.md): screenshot asset plan and expected filenames.

Important settings include:

- `praxis.backendMode`
- `praxis.boardsSidebarPreviewMode`
- `praxis.jiraPolling.enabled`
- `praxis.ai.provider`
- `praxis.ai.agentName`
- `praxis.ai.deliveryWorkflowEnabled`

## Getting started

1. Open `Praxis: Open Connections & Boards`.
2. Add a connection that matches the backend you want to use.
3. Add one or more tracked boards.
4. Open a tracked board from the Boards or Work Mode view.
5. Use the issue views, Issue Details, Task Designer, and AI/session tools from there.

If you prefer the board-centric layout, set `praxis.boardsSidebarPreviewMode` to `work` or run `Praxis: Toggle Work Mode`.

## Board settings

Tracked boards can be customized from `Praxis: Configure Board Settings`.

- `Statuses` is the main editor for status order, naming, visibility on the board, and per-status colors.
- Board filters can narrow tickets by assignee, epic, age, and included statuses.
- Ticket type colors control issue-type accents on the board and in Task Designer when that board is active.
- Swim lanes can group the board by assignee or epic.

## Screenshots and walkthroughs

The repo does not currently include image assets for the UI. The documentation now reserves these walkthrough sections so screenshots can be dropped in without changing the doc structure.

Suggested capture set:

- Connections & Boards setup flow
- Classic sidebar mode
- Work Mode board view
- Issue Details view
- Sessions view / AI session panel
- Task Designer with notes, website preview nodes, and connectors
- Task Designer AI recommendation and master-plan flow

Detailed placeholders live in [docs/user-guide.md](docs/user-guide.md).
Expected asset names live in [docs/screenshots/README.md](docs/screenshots/README.md).

## Development

Root scripts are prefixed by the surface they act on, so it is always clear what
a command will build or test. Unprefixed `build`, `test`, and `check-types` cover
every workspace.

### Build

```powershell
npm install
npm run build            # everything, in dependency order
npm run build:vscode     # just the extension
npm run build:core       # just the shared core
```

Press `F5` in VS Code to launch the Extension Development Host.

### Typecheck

```powershell
npm run check-types      # every workspace
```

### Tests

```powershell
npm test                 # core + desktop + extension
npm run test:core
npm run test:desktop     # Playwright e2e
npm run test:vscode      # launches a real VS Code
```

`npm run test:vscode` needs a GUI session and a VS Code download; see AGENTS.md
for the macOS arm64 caveat that stops it running on some machines.

### Package

```powershell
npm run package:vscode
```

## Utility scripts

- `npm run vscode:open`
- `npm run vscode:install:vsix`
- `npm run vscode:install:code`
- `npm run vscode:install:insiders`
- `npm run vscode:install:cursor`
- `npm run jira-mr-polling`
- `npm run jira-mr-polling:once`
- `npm run jira-mr-polling:test`

Installer/package helper scripts write extension packages to `artifacts/` (for example `artifacts/praxis-<version>.vsix`).

## Migration docs

- [docs/migrations/live-folder-to-jira-gitlab-github.md](docs/migrations/live-folder-to-jira-gitlab-github.md)
- [docs/migrations/live-folder-to-jira-implementation-plan.md](docs/migrations/live-folder-to-jira-implementation-plan.md)

These migration docs are planning/implementation documents, not end-user feature guarantees.

## Known limitations

- GitHub mode is not yet a full issue/board backend with Jira-equivalent parity.
- GitLab support is strongest around delivery/MR workflows and does not mirror Jira behavior exactly.
- Website preview nodes only show sites that permit embedding.
- Some automation flows depend on correct Jira/GitLab credentials, workflow settings, tracked boards, and repository setup.
