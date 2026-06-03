# Ticket Manager User Guide

## Overview

Ticket Manager is a VS Code extension for managing issues, boards, AI sessions, and delivery workflows without leaving the editor.

The extension combines:

- backend connections and tracked-board management,
- board and issue workflows,
- AI-assisted review and delivery,
- local markdown-backed planning,
- and a visual Task Designer for execution planning.

## Core concepts

### Connections and tracked boards

The extension is organized around named backend connections and explicitly tracked boards.

- Connections define how Ticket Manager talks to a backend.
- Tracked boards are the board records you choose to show in the extension.
- Selecting a tracked board also selects the connection used for routed board and issue operations.

The canonical setup surface is the **Connections & Boards** panel.

### Sidebar modes

Ticket Manager has two sidebar layouts.

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
- The mode can be toggled with `Ticket Manager: Toggle Work Mode` or by setting `ticketManager.boardsSidebarPreviewMode` to `work`.

### Panels and detail surfaces

Beyond the sidebar views, Ticket Manager includes:

- Connections & Boards panel
- Full Issue Details panel
- Task Designer panel
- Local Peer Review panel
- Copilot / agent session panel

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

### Jira Cloud (`jiracloud`)

Primary hosted tracker mode.

Supported capabilities include:

- issue browse/select/open flows,
- board browsing and tracking,
- comments,
- status transitions,
- attachments,
- linked epic / linked board query setup,
- Jira Cloud OAuth site metadata,
- Jira polling and delivery workflow integration.

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
- migration support toward Jira Cloud.

### User Workspace (`userworkspace`)

Uses local workspace-backed issue storage for lighter local workflows.

## Main workflows

### Project setup

Use these entry points:

- `Ticket Manager: Open Connections & Boards`
- `Ticket Manager: Add Connection`
- `Ticket Manager: Add Tracked Board`
- `Ticket Manager: Configure Project`
- `Ticket Manager: Set Backend Mode`

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
- `Migrate Live Folder to Jira Cloud`
- `Link Jira Cloud Epic`
- `Link Jira Cloud Board Query`

Migration docs live under [docs/migrations](migrations/live-folder-to-jira-gitlab-github.md).

## Command reference

This section is a grouped summary. The dedicated reference lives in [docs/command-reference.md](command-reference.md) and is generated from the extension manifest.

### Setup and navigation

- `Ticket Manager: Refresh`
- `Ticket Manager: Configure Jira Cloud Connection`
- `Ticket Manager: Check Connection`
- `Ticket Manager: Disconnect Jira Cloud`
- `Ticket Manager: Set Backend Mode`
- `Ticket Manager: Configure Project`
- `Ticket Manager: Open Settings`
- `Ticket Manager: Toggle Work Mode`
- `Ticket Manager: Open Connections & Boards`
- `Ticket Manager: Add Connection`
- `Ticket Manager: Add Tracked Board`

### Board and issue creation

- `Ticket Manager: Open Board`
- `Ticket Manager: Create Board`
- `Ticket Manager: Create Issue`
- `Ticket Manager: Create Idea`
- `Ticket Manager: Create EPIC`
- `Ticket Manager: New Project`

### Search and filtering

- `Ticket Manager: Search Boards`
- `Ticket Manager: Search Issues`
- `Ticket Manager: Search EPICs`
- `Ticket Manager: Set Board Projects`
- `Ticket Manager: Set Board Types`
- `Ticket Manager: Set Board Search Text`
- `Ticket Manager: Clear Board Filters`
- `Ticket Manager: Set Projects`
- `Ticket Manager: Set Status Filter`
- `Ticket Manager: Set Issue Type Filter`
- `Ticket Manager: Set Search Text`
- `Ticket Manager: Toggle Assignee Scope`
- `Ticket Manager: Set Parent Item Scope`
- `Ticket Manager: Clear Parent Item Scope`
- `Ticket Manager: Clear Filters`

### Board and issue actions

- `Ticket Manager: Configure Board Settings`
- `Ticket Manager: Change Status`
- `Ticket Manager: Open Full Issue Details`
- `Ticket Manager: Open External Link`
- `Ticket Manager: Copy Issue Key`
- `Ticket Manager: Load More`
- `Ticket Manager: Assign to Me`
- `Ticket Manager: Assign to AI Agent`
- `Ticket Manager: Abandon AI Session`

### AI and session workflows

- `Ticket Manager: Configure AI`
- `Ticket Manager: Delegate to Copilot Agent`
- `Ticket Manager: Start Claude Code Session`
- `Ticket Manager: Assign Workflow Pack`
- `Ticket Manager: View AI Session`
- `Ticket Manager: Abort Agent Session`
- `Ticket Manager: Review Ticket with AI`
- `Ticket Manager: Local Peer Review (LPR)`
- `Ticket Manager: Start Sub-Task Delivery`

### Planning and migration

- `Ticket Manager: Open Task Designer`
- `Ticket Manager: Import Plan from Markdown Features`
- `Ticket Manager: Import Markdown Files to Template Format`
- `Ticket Manager: Migrate Live Folder to Jira Cloud`
- `Ticket Manager: Link Jira Cloud Epic`
- `Ticket Manager: Link Jira Cloud Board Query`

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