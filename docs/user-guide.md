# Praxis User Guide

## Overview

Praxis is a VS Code extension for managing issues, boards, AI sessions, and delivery workflows without leaving the editor.

The extension combines:

- backend connections and tracked-board management,
- board and issue workflows,
- AI-assisted review and delivery,
- local markdown-backed planning,
- and a visual Task Designer for execution planning.

## Core concepts

### Connections and tracked boards

The extension is organized around named backend connections and explicitly tracked boards.

- Connections define how Praxis talks to a backend.
- Tracked boards are the board records you choose to show in the extension.
- Selecting a tracked board also selects the connection used for routed board and issue operations.

The canonical setup surface is the **Connections & Boards** panel.

### Sidebar modes

Praxis has two sidebar layouts.

#### Classic mode

Classic mode exposes separate views for:

- Boards
- EPICs
- My Issues
- Sessions
- Issue Details

#### Work Mode

Work Mode is the board-centric layout.

- Boards render as richer cards.
- Active AI sessions are shown under their owning board.
- The mode can be toggled with `Praxis: Toggle Work Mode` or by setting `praxis.boardsSidebarPreviewMode` to `work`.

### Panels and detail surfaces

Beyond the sidebar views, Praxis includes:

- Connections & Boards panel
- Full Issue Details panel
- Task Designer panel
- Local Peer Review panel
- Copilot / agent session panel

### Praxis desktop workspaces

The Praxis desktop app adds a saved workspace layer above Projects. A workspace
is a named operating context for a collection of projects, connections,
objectives, and the current project context. Projects remain the owners of
their boards and repository folders.

Use the workspace selector at the top of the desktop sidebar to:

- create a workspace,
- switch between workspaces,
- save the current workspace to a `.praxis-workspace.json` file, or
- open a previously saved workspace file.

Workspace files are versioned. They record `schemaVersion`,
`createdWithAppVersion`, and `lastSavedWithAppVersion`. Praxis refuses a file
with a newer unsupported schema instead of overwriting local workspace data.
Secrets and credentials are never exported.

By default, Praxis reopens the selected workspace and the last durable view you
used. Change this under **Settings → Startup → Reopen last workspace**. When the
setting is off, Praxis opens Getting Started after the startup splash so you can
choose, create, or import a workspace. Missing or deleted saved workspaces also
fall back safely. Transient create forms are not restored.

A workspace is required before creating or adding a project. On first launch,
Getting Started asks for a workspace name and optional description, then offers
**Create New Project**, **Add Existing Project**, or **Continue with Empty
Workspace**. The existing project wizard opens in the selected workspace. Its
first project becomes the workspace default; projects can later be referenced
by more than one workspace.

Desktop navigation is contextual: Epics and Issues appear when a board is
selected; Repository tools appear under their owning project; global surfaces
such as Overview, Connections, and Agents remain available independently.

## Screenshots and walkthroughs

The repository does not currently include checked-in screenshot assets, but this section defines the intended walkthrough coverage for the main product areas.

### Suggested screenshot set

- Connections & Boards panel with at least one configured connection and tracked board
- Classic mode sidebar showing Boards, EPICs, My Issues, Sessions, and Issue Details
- Work Mode sidebar with boards and nested active sessions
- Issue Details view with transitions and AI actions
- Local Peer Review panel
- Task Designer canvas with ticket, note, and website preview nodes

Suggested filenames are listed in [docs/screenshots/README.md](screenshots/README.md).

### Suggested walkthrough sequence

1. Configure a backend connection in Connections & Boards.
2. Add one or more tracked boards.
3. Open a board in Classic mode.
4. Toggle Work Mode and show the board-centric layout.
5. Select an issue and open Issue Details.
6. Assign the issue to an AI provider or open Local Peer Review.
7. Open Task Designer and show ticket placement, notes, website previews, connectors, and zoom.
8. Show AI recommendation or master-plan generation from the Task Designer.

## Supported backends

### Jira MCP (`jiracloud`)

Primary hosted tracker mode. Backed by an external Jira MCP server
(`atlassian-jira_*` from `jira-mcp-server` or `mcp_com_atlassian_*` from
`mcp.com.atlassian`).

Supported capabilities include:

- issue browse/select/open flows,
- board browsing and tracking,
- comments,
- status transitions,
- linked epic / linked board query setup (`praxis.jiraMcpEpicKey`,
  `praxis.jiraMcpBoardJql`),
- AI-driven delivery workflow that runs against the MCP connection.

### Demo (`demo`)

Built-in sample backend for development and demos.

### GitHub (`github`)

Configuration exists, but issue/board behavior is not at Jira parity.

### GitLab (`gitlab`)

Supports connection and delivery/MR-related workflows, but does not behave like a full Jira-equivalent issue/board backend.

### Live Folder (`livefolder`)

Uses markdown plans and issue files on disk.

Capabilities include:

- reading markdown issue structures,
- optional local issue creation,
- markdown import helpers,
- migration support toward a configured Jira MCP server.

### User Workspace (`userworkspace`)

Uses local workspace-backed issue storage for lighter local workflows.

## Main workflows

### Project setup

Use these entry points:

- `Praxis: Open Connections & Boards`
- `Praxis: Add Connection`
- `Praxis: Add Tracked Board`
- `Praxis: Configure Project`
- `Praxis: Set Backend Mode`

### Board workflows

Available capabilities include:

- open a tracked board,
- search boards,
- filter boards by project and type,
- clear board filters,
- configure board settings/columns,
- create issues from a board,
- open board-specific issue workflows.

#### Board settings

Board settings are centered around a single `Statuses` editor.

- Use `Customize statuses and columns` to switch from the board's detected defaults to a local override.
- Reorder statuses by dragging them.
- Rename statuses inline.
- Add or remove statuses from the same list.
- Use `Visible on board` to control which statuses appear as board columns.
- Set each status color in the same row so column visibility, naming, and color stay together.

Other board-level controls include:

- swim lane grouping,
- board-level ticket filters,
- board list pill color,
- ticket type colors for issue pills, board accents, and Task Designer ticket colors.

### Issue workflows

Issue-related capabilities include:

- create issue,
- create idea,
- search issues,
- search EPICs,
- set project/type/status/search filters,
- toggle assignee scope,
- set and clear parent scope,
- assign to me,
- assign to AI,
- abandon AI session,
- change status,
- comment and edit from Issue Details,
- open full details,
- open in browser,
- copy issue key.

### AI and review workflows

AI capabilities include:

- configure AI providers,
- delegate to Copilot agent,
- start Claude Code session,
- assign workflow pack,
- view AI session,
- abort agent session,
- review ticket with AI,
- run Local Peer Review,
- poll Jira for work and optionally run clarification analysis,
- execute delivery workflows,
- start sub-task delivery.

### Task Designer workflows

The Task Designer is the visual planning workspace.

Supported functionality includes:

- opening the Task Designer panel,
- adding ticket nodes,
- adding note nodes,
- adding website preview nodes,
- dragging tickets from issue surfaces onto the designer,
- drawing curved directed links between connectors,
- selecting and deleting connectors,
- dragging and resizing custom nodes,
- zoom in / zoom out,
- task-designer AI recommendation flow,
- generating a master plan from the current ticket graph.

Notes about Task Designer behavior:

- Ticket nodes participate in AI recommendation and master-plan flows.
- Note and website nodes are preserved in designer state, but are not treated as executable ticket graph nodes.
- Website previews rely on iframe embedding; some sites will refuse to display.
- When opened from an active board context, Task Designer uses that board's ticket type color settings for ticket nodes.

### Live Folder and migration workflows

The extension includes:

- `Import Plan from Markdown Features`
- `Import Markdown Files to Template Format`
- `Migrate Live Folder to Jira`
- `Link Jira MCP Epic`
- `Link Jira MCP Board Query`

Migration docs live under [docs/migrations](migrations/live-folder-to-jira-gitlab-github.md) and [docs/migrations/removed-jira-polling.md](migrations/removed-jira-polling.md).

## Command reference

This section is a grouped summary. The dedicated reference lives in [docs/command-reference.md](command-reference.md) and is generated from the extension manifest.

### Setup and navigation

- `Praxis: Refresh`
- `Praxis: Configure Jira MCP Connection`
- `Praxis: Check Connection`
- `Praxis: Set Backend Mode`
- `Praxis: Configure Project`
- `Praxis: Open Settings`
- `Praxis: Toggle Work Mode`
- `Praxis: Open Connections & Boards`
- `Praxis: Add Connection`
- `Praxis: Add Tracked Board`

### Board and issue creation

- `Praxis: Open Board`
- `Praxis: Create Board`
- `Praxis: Create Issue`
- `Praxis: Create Idea`
- `Praxis: Create EPIC`
- `Praxis: New Project`

### Search and filtering

- `Praxis: Search Boards`
- `Praxis: Search Issues`
- `Praxis: Search EPICs`
- `Praxis: Set Board Projects`
- `Praxis: Set Board Types`
- `Praxis: Set Board Search Text`
- `Praxis: Clear Board Filters`
- `Praxis: Set Projects`
- `Praxis: Set Status Filter`
- `Praxis: Set Issue Type Filter`
- `Praxis: Set Search Text`
- `Praxis: Toggle Assignee Scope`
- `Praxis: Set Parent Item Scope`
- `Praxis: Clear Parent Item Scope`
- `Praxis: Clear Filters`

### Board and issue actions

- `Praxis: Configure Board Settings`
- `Praxis: Change Status`
- `Praxis: Open Full Issue Details`
- `Praxis: Open External Link`
- `Praxis: Copy Issue Key`
- `Praxis: Load More`
- `Praxis: Assign to Me`
- `Praxis: Assign to AI Agent`
- `Praxis: Abandon AI Session`

### AI and session workflows

- `Praxis: Configure AI`
- `Praxis: Delegate to Copilot Agent`
- `Praxis: Start Claude Code Session`
- `Praxis: Assign Workflow Pack`
- `Praxis: View AI Session`
- `Praxis: Abort Agent Session`
- `Praxis: Review Ticket with AI`
- `Praxis: Local Peer Review (LPR)`
- `Praxis: Start Sub-Task Delivery`

### Planning and migration

- `Praxis: Open Task Designer`
- `Praxis: Import Plan from Markdown Features`
- `Praxis: Import Markdown Files to Template Format`
- `Praxis: Migrate Live Folder to Jira`
- `Praxis: Link Jira MCP Epic`
- `Praxis: Link Jira MCP Board Query`

## Live Folder mode

Live Folder mode expects a markdown plan layout rooted at a `plans` or `features` tree.

Common structure:

- `plans/features/feature-NN-name/feature.md`
- `plans/features/feature-NN-name/story-NN-M-name.md`
- `plans/features/feature-NN-name/task-NN-M-name.md`
- `plans/features/feature-NN-name/bug-NN-M-name.md`

Supported issue types:

- Feature
- Story
- Task
- Bug

Common metadata handled by the extension includes status, priority, dependencies, comments, and descriptive content sections.

## Settings reference

See [docs/settings-reference.md](settings-reference.md) for the shipped settings grouped by feature area.

## Known limitations

- GitHub support remains configuration-first rather than full backend parity.
- GitLab support is strongest for delivery/MR workflows rather than Jira-like board behavior.
- Website preview nodes only work for sites that allow embedding.
- Delivery workflows depend on correct repo, credential, and backend configuration.
