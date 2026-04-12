# Ticket Manager — Comprehensive Documentation

> **Version:** 0.0.1  
> A compact issue and board sidebar for VS Code with connected, demo, and file-backed modes.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Getting Started](#2-getting-started)
3. [Backend Modes](#3-backend-modes)
4. [Sidebar Views](#4-sidebar-views)
5. [AI Agent Assignment](#5-ai-agent-assignment)
6. [Local Peer Review (LPR)](#6-local-peer-review-lpr)
7. [New Project Wizard (Preview)](#7-new-project-wizard-preview)
8. [Board Management](#8-board-management)
9. [Commands Reference](#9-commands-reference)
10. [Settings Reference](#10-settings-reference)
11. [Keyboard Shortcuts](#11-keyboard-shortcuts)
12. [Development Guidelines](#12-development-guidelines)
13. [Known Limitations](#13-known-limitations)

---

## 1. Overview

**Ticket Manager** is a VS Code extension that puts issue tracking and board management directly in your editor sidebar. It provides a unified UI for browsing issues, managing boards, viewing issue details, and tracking AI agent assignments — all without leaving VS Code.

### Supported Backends

| Backend | Status | Description |
|---------|--------|-------------|
| **Jira** | ✅ Fully implemented | Connects via MCP (Model Context Protocol) to a Jira server |
| **GitHub** | 🚧 Planned | Configuration UI ready; backend service not yet implemented |
| **GitLab** | 🚧 Planned | Configuration UI ready; backend service not yet implemented |
| **File/Plan** | ✅ Fully implemented | Local JSONC plan file — no external service needed |
| **Demo** | ✅ Fully implemented | Built-in sample data for evaluation and testing |

### Architecture

The extension uses a **backend router** pattern: the UI layer is decoupled from the data layer, so every sidebar view, board editor, and command works identically regardless of which backend is active. Switching modes is instant — no restart required.

---

## 2. Getting Started

### Installation

#### From VSIX (recommended for local use)

Pre-built VSIX packages are included in the repository:

```sh
# Cross-platform (Node.js) — installs into VS Code and/or VS Code Insiders
npm run install:vsix
npm run install:vsix -- --target=code       # VS Code only
npm run install:vsix -- --target=insiders   # Insiders only

# Windows PowerShell scripts
npm run install:code       # VS Code
npm run install:insiders   # VS Code Insiders
npm run install:cursor     # Cursor IDE
```

The install scripts in `scripts/` handle building the VSIX and installing it automatically:

| Script | Target | Platform |
|--------|--------|----------|
| `scripts/install-vsix.cjs` | VS Code / Insiders / both | Cross-platform (Node.js) |
| `scripts/install-vscode.ps1` | VS Code | Windows (PowerShell) |
| `scripts/install-vscode-insiders.ps1` | VS Code Insiders | Windows (PowerShell) |
| `scripts/install-cursor-extension.ps1` | Cursor IDE | Windows (PowerShell) |

#### From source (development)

```sh
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host.

### First-Time Setup

When you open VS Code with Ticket Manager installed:

1. A **Tickets** icon appears in the Activity Bar (left sidebar).
2. Click it to reveal the sidebar. Since no backend is configured yet, the **Configure Project** view appears automatically.
3. Choose a backend mode (Jira, Demo, File, GitHub, or GitLab).
4. Complete the mode-specific configuration (see [Backend Modes](#3-backend-modes)).
5. Once configured, the sidebar switches to show **Boards**, **EPICs**, **My Issues**, and **Issue Details** views.

You can reconfigure at any time via the **Set Backend Mode** command or the gear icon in the sidebar toolbar.

---

## 3. Backend Modes

Switch modes at any time with:
- **Command Palette** → `Ticket Manager: Set Backend Mode`
- **Setting:** `ticketManager.backendMode`

### Jira Connected

Connects to a Jira instance through a **Jira MCP server** using the Model Context Protocol.

**Connection types:**

| Type | Setting | Description |
|------|---------|-------------|
| **stdio** (default) | `ticketManager.connectionType = "stdio"` | Launches a local MCP server process |
| **HTTP** | `ticketManager.connectionType = "http"` | Connects to a remote MCP server via HTTP |

**stdio configuration:**

```jsonc
// .vscode/settings.json
{
  "ticketManager.backendMode": "jira",
  "ticketManager.connectionType": "stdio",
  "ticketManager.stdioCommand": "npx",
  "ticketManager.stdioArgs": ["-y", "@anthropic/jira-mcp-server"],
  "ticketManager.stdioCwd": ""
}
```

**HTTP configuration:**

```jsonc
{
  "ticketManager.backendMode": "jira",
  "ticketManager.connectionType": "http",
  "ticketManager.httpUrl": "https://your-mcp-server.example.com"
}
```

**MCP auto-discovery:** The extension can import MCP server configuration from existing sources:

- **Workspace MCP:** Reads from `.vscode/mcp.json` — use `Ticket Manager: Use Workspace MCP Configuration` command or set `ticketManager.workspaceMcpServerName`.
- **User/Profile MCP:** Reads from your user/profile MCP configuration — use `Ticket Manager: Use User/Profile MCP Configuration` command or set `ticketManager.userMcpServerRef`.

### GitHub

> ⚠️ **Status:** Configuration UI and settings are ready. The backend service is **not yet implemented**.

**Configuration fields:**

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ticketManager.githubPat` | string | `""` | GitHub Personal Access Token |
| `ticketManager.githubUrl` | string | `"https://api.github.com"` | GitHub API base URL (change for GitHub Enterprise) |
| `ticketManager.githubOwner` | string | `""` | GitHub organisation or user that owns the repositories |

```jsonc
{
  "ticketManager.backendMode": "github",
  "ticketManager.githubPat": "ghp_xxxxxxxxxxxx",
  "ticketManager.githubUrl": "https://api.github.com",
  "ticketManager.githubOwner": "my-org"
}
```

### GitLab

> ⚠️ **Status:** Configuration UI and settings are ready. The backend service is **not yet implemented**.

**Connection types:**

| Type | Setting | Description |
|------|---------|-------------|
| **API Key** (default) | `ticketManager.gitlabConnectionType = "api"` | Direct API access with a Personal Access Token |
| **MCP Server** | `ticketManager.gitlabConnectionType = "mcp"` | Connect through a GitLab MCP server |

**API Key configuration:**

```jsonc
{
  "ticketManager.backendMode": "gitlab",
  "ticketManager.gitlabUrl": "https://gitlab.com",
  "ticketManager.gitlabConnectionType": "api",
  "ticketManager.gitlabApiKey": "glpat-xxxxxxxxxxxx"
}
```

**MCP Server configuration:**

```jsonc
{
  "ticketManager.backendMode": "gitlab",
  "ticketManager.gitlabUrl": "https://gitlab.com",
  "ticketManager.gitlabConnectionType": "mcp",
  "ticketManager.gitlabMcpCommand": "npx",
  "ticketManager.gitlabMcpArgs": ["-y", "@anthropic/gitlab-mcp-server"]
}
```

### File / Plan

Uses a local JSONC (JSON with Comments) file as the backend. All changes are persisted directly to the file — no external service required.

**Auto-discovery:** The extension searches for plan files in this order:

1. `ticket-plan.jsonc`
2. `ticket-plan.json`
3. `.vscode/ticket-plan.jsonc`
4. `.vscode/ticket-plan.json`

If no plan file is found, the extension offers to create a starter template.

**Manual configuration:**

```jsonc
{
  "ticketManager.backendMode": "file",
  "ticketManager.planFilePath": "./my-project-plan.jsonc"
}
```

The plan file path can be absolute or workspace-relative.

**Plan file structure:**

```jsonc
{
  // Projects
  "projects": [
    { "key": "PRJ", "name": "My Project" }
  ],
  // Statuses and transitions
  "statuses": ["Backlog", "In Progress", "Done"],
  "transitions": { /* status transition mappings */ },
  // Boards
  "boards": [
    { "id": "1", "name": "Sprint Board", "type": "scrum", "columns": { /* ... */ } }
  ],
  // Issues
  "issues": [
    {
      "key": "PRJ-1",
      "summary": "Implement feature X",
      "issueType": "Story",
      "status": "Backlog",
      "assignee": "developer@example.com"
      // ...additional fields
    }
  ]
}
```

**Importing from Markdown:** Use the `Ticket Manager: Import Plan from Markdown Features` command to convert a structured Markdown file into a plan file.

### Demo

Built-in sample data for quick evaluation and testing. No configuration needed — just select **Demo** as the backend mode.

**Demo data includes:**
- Multiple projects (PRJ, QA)
- Various issue types: Epic, Feature, Story, Task, Bug, Subtask
- Issues in different status categories: Backlog, In Progress, Done, Blocked
- Parent-child relationships (Epic → Story → Task)
- Scrum and Kanban boards
- Some issues configured to simulate transition failures (for error-handling testing)

```jsonc
{
  "ticketManager.backendMode": "demo"
}
```

---

## 4. Sidebar Views

When configured, the Ticket Manager sidebar shows four views in this order:

### Boards

Browse and manage boards from the active backend.

- **Board list** with type indicators (Scrum / Kanban)
- **Backend mode icon** with customisable accent colour beside each board name
- **Toolbar actions:**
  - Refresh, Create Board, Create Issue, Search Boards
  - Set Board Projects, Set Board Types, Configure Board Settings
  - Clear Board Filters, Set Backend Mode
- **Inline actions per board:** Edit Board, Delete Board
- Click a board to open it in an **editor tab** with column-based layout

### EPICs

Browse parent items (Epics) from the active backend.

- **EPIC list** with status indicators
- **Toolbar actions:** Refresh, Create EPIC, Search EPICs
- **Search bar** for filtering EPICs by text
- Select an EPIC to **scope the My Issues view** by parent item
- Create, edit, and delete EPICs

### My Issues

The primary issue list with powerful filtering capabilities.

- **Search bar** at the top for text search
- **Filter toolbar:**
  - Set Projects (multi-select)
  - Set Status Filter (multi-select)
  - Set Issue Type Filter (multi-select)
  - Toggle Assignee Scope ("me" / "all")
  - Set Parent Item Scope (filter by EPIC)
  - Clear Filters
- **Issue list** showing:
  - Issue key and summary
  - Status badge with colour coding (category-aware)
  - Issue type badge with colour
  - Assignee display
  - 🤖 AI badge when an AI agent is assigned
- **Inline actions per issue:** Open in Browser, Change Status
- **Context menu:** Copy Issue Key
- **Load More** button for pagination (configurable page size via `ticketManager.defaultPageSize`)

### Issue Details

Displays full details for the currently selected issue.

- **Header:** Issue key, summary, status, issue type, priority
- **Description:** Rendered from Markdown to HTML
- **Comments:** Listed with author and timestamp; comment textarea placeholder shows configured @mention names
- **Status transitions:** Change Status button with available transitions
- **Parent reference:** Link to parent issue if applicable
- **Quick-assign buttons:** "Assign to Me" and "Assign to AI" next to the assignee field
- **Local Peer Review button:** Triggers an AI code review, security review, and summary in a dedicated panel
- **AI Assignment card:** When an AI agent is assigned, shows provider, session ID, assignment time, and status
- **External link:** Open in Browser button
- **Toolbar actions:** Change Status, Open External Link, Open Full Details (editor tab), Assign to AI Agent, Unassign AI Agent

---

## 5. AI Agent Assignment

Track AI agent assignments for issues directly in the sidebar.

### Configuration

Configure AI providers via settings:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ticketManager.ai.openaiApiKey` | string | `""` | OpenAI API key |
| `ticketManager.ai.claudeApiKey` | string | `""` | Claude/Anthropic API key |
| `ticketManager.ai.cursorCliPath` | string | `""` | Path to the Cursor CLI executable |
| `ticketManager.ai.copilotEnabled` | boolean | `false` | Enable the GitHub Copilot SDK using the machine's existing Copilot authentication |
| `ticketManager.ai.copilotCliPath` | string | `""` | Legacy compatibility override for the runtime used by the GitHub Copilot SDK. Leave empty unless debugging a local Copilot installation |
| `ticketManager.ai.defaultProvider` | enum | `"none"` | Default AI provider (`openai`, `claude`, `cursor-cli`, `copilot-cli`, `none`) |
| `ticketManager.ai.openaiAgentName` | string | `""` | Display name for the OpenAI agent (e.g. "GPT-4 Reviewer") |
| `ticketManager.ai.claudeAgentName` | string | `""` | Display name for the Claude agent (e.g. "Claude AI") |
| `ticketManager.ai.mentionName` | string | `""` | Custom @mention name for AI replies in comments (e.g. "daveai") |

### How to Assign

There are multiple ways to assign a ticket:

1. **From the issue detail panel:** Click "Assign to Me" or "Assign to AI" below the assignee field.
2. **From the board:** Right-click a card and select an assignment option.
3. **From the sidebar toolbar:** Click the 🤖 **Assign to AI Agent** button.
4. **From the Command Palette:** Run `Ticket Manager: Assign to AI Agent` or `Ticket Manager: Assign to Me`.

If no default provider is set, you will be prompted to pick from the available providers.

### Copilot Agent Sessions

When using the GitHub Copilot SDK, you can start **autonomous agent sessions** where the AI actively works on the ticket:

1. Assign the ticket to AI or use **Delegate to Copilot**.
2. Define the task: goal, scope, and definition of done.
3. If a **plan file** exists and contains the issue key, plan context is automatically included in the goal.
4. The agent runs autonomously — planning, reading/writing files, running commands — with permission gates.
5. Step limit warnings appear at 80% of the configured limit (default: 500 steps), with options to continue, remove the limit, or stop.

### @Mention AI in Comments

- When you add a comment containing `@copilot`, the extension posts your comment and then adds an AI reply as a follow-up.
- **Custom mention name:** Set `ticketManager.ai.mentionName` to a custom name (e.g. `"daveai"`). Both `@copilot` and `@daveai` will trigger AI replies.
- The comment textarea placeholder dynamically shows the configured mention names.
- Mentions are only triggered for comments submitted through this extension UI.

### Session Tracking

Each AI assignment records:

| Field | Description |
|-------|-------------|
| `provider` | Which AI provider (`openai`, `claude`, `cursor-cli`, `copilot-cli`) |
| `sessionId` | Unique hex identifier for the session |
| `assignedAt` | ISO 8601 timestamp of when the assignment was created |
| `status` | `active`, `completed`, or `failed` |

Sessions are persisted in VS Code workspace state.

For GitHub Copilot SDK sessions, Ticket Manager creates real persistent Copilot sessions so they can be resumed later. That means they may also appear in Copilot history. A standalone visible console window is not intended as part of normal operation.

### Visual Indicators

- **My Issues list:** Issues with an active AI assignment display a 🤖 badge.
- **Issue Details view:** An **AI Assignment** card appears showing the provider, session ID, assigned time, and current status.

### How to Unassign

- In the **Issue Details** toolbar, click the ✕ **Unassign AI Agent** button.
- Or run `Ticket Manager: Unassign AI Agent` from the Command Palette.

---

## 6. Local Peer Review (LPR)

Run an AI-powered peer review for any ticket directly in VS Code. The LPR opens a dedicated panel with three review sections.

### How to Run

1. **From the issue detail panel:** Click the **Local Peer Review** button in the form actions.
2. **From the Command Palette:** Run `Ticket Manager: Local Peer Review (LPR)`.
3. If multiple AI providers are configured, you will be prompted to select one.

### Review Sections

| Section | Description |
|---------|-------------|
| **Ticket Details** | Summary of the ticket: key, type, status, priority, assignee, and description |
| **Code Review** | AI analysis of code quality, potential bugs, design patterns, test coverage, and performance |
| **Security Review** | AI analysis of OWASP Top 10 vulnerabilities, auth issues, data exposure, input validation, and dependency risks |
| **Summary & Verdict** | Overall assessment (Ready / Needs Changes / Needs Major Rework), key findings, and recommended next steps |

### Supported Providers

LPR works with all configured AI providers: OpenAI, Claude, and GitHub Copilot SDK.

### Refreshing

Click the refresh icon in the panel header to re-run the review with the latest ticket data.

---

## 7. New Project Wizard (Preview)

A multi-step guided workflow for defining and launching a new project.

### Enabling

This feature is behind a preview flag and disabled by default:

```jsonc
{
  "ticketManager.enableNewProject": true
}
```

When enabled, the `Ticket Manager: New Project` command appears in the Command Palette.

### Wizard Steps

1. **Define Goal** — Project name, description, category, priority, and timeline; objectives and success criteria; technical and business requirements; constraints.
2. **Team & Roles** — Define roles (title, description, skills, seniority, count); assign team members (name, email, role, availability).
3. **Review & Launch** — AI-powered review with scoring, gap analysis, suggestions, and risk assessment; final confirmation to launch.

### AI Review

Each step can trigger an AI review that returns:

| Field | Description |
|-------|-------------|
| `score` | Numeric quality score |
| `gaps` | Identified gaps in the plan |
| `suggestions` | Improvement recommendations |
| `questions` | Clarifying questions |
| `status` | `ready`, `needs-attention`, or `critical` |
| `checklist` | Validation checklist items |
| `riskLevel` | `low`, `medium`, or `high` |

---

## 8. Board Management

### Creating Boards

1. Click the **+** (Create Board) button in the Boards toolbar.
2. Enter a board name and select the board type (Scrum or Kanban).
3. The new board appears in the sidebar list.

### Opening Boards

Click a board in the list (or use the inline **Open Board** button) to open it in an **editor tab**. The board displays:

- **Columns** mapped to workflow statuses
- **Issue cards** with key, summary, type badge, and status
- **Drag-and-drop** to move issues between columns (triggers status transitions)
- **Intra-column card reordering** — drag tickets above or below other tickets within the same column to set visual priority order. A blue drop indicator line shows the insertion point. Order is persisted per board in workspace state and does not affect ticket details.
- **Swim lanes** for optional grouping
- **Selected issue highlighting**
- **Card border colour** uses the board's focus colour (`--vscode-focusBorder`) for a consistent branded look

### Board Column Configuration

Customise which columns appear per board:

1. Click the ⚙️ **Configure Board Settings** button in the toolbar or inline on a board.
2. Toggle column visibility.
3. Column preferences are persisted per board in VS Code workspace state.

### Board Filters

Filter the board contents using the toolbar:

| Filter | Command | Description |
|--------|---------|-------------|
| Projects | `Set Board Projects` | Filter by one or more projects |
| Issue Types | `Set Board Types` | Filter by issue types |
| Search Text | `Set Board Search Text` | Free-text search within the board |
| Clear All | `Clear Board Filters` | Reset all board filters |

### Editing and Deleting Boards

- **Edit:** Available through inline action buttons on each board in the Boards sidebar.
- **Delete:** Available through inline action buttons on each board in the Boards sidebar. Removes the board and its column configuration.

---

## 9. Commands Reference

All commands are in the **Ticket Manager** category.

### Core

| Command | ID | Description |
|---------|----|-------------|
| Refresh | `ticketManager.refresh` | Reload all data from the active backend |
| Configure Connection | `ticketManager.configureConnection` | Open Jira MCP connection setup wizard |
| Check Connection | `ticketManager.checkConnection` | Test backend connectivity |
| Set Backend Mode | `ticketManager.setBackendMode` | Switch between Jira / Demo / File / GitHub / GitLab |
| Configure Project | `ticketManager.openSetup` | Open the configuration sidebar |

### Project & Import

| Command | ID | Description |
|---------|----|-------------|
| Import Plan from Markdown Features | `ticketManager.importMarkdownFeaturePlan` | Convert structured Markdown into a plan file |
| New Project | `ticketManager.newProject` | Launch the New Project wizard (preview) |
| Use Workspace MCP Configuration | `ticketManager.importWorkspaceMcpConfig` | Import MCP server config from `.vscode/mcp.json` |
| Use User/Profile MCP Configuration | `ticketManager.importUserMcpConfig` | Import MCP server config from user/profile settings |

### Boards

| Command | ID | Description |
|---------|----|-------------|
| Open Board | `ticketManager.openBoard` | Open a board in an editor tab |
| Create Board | `ticketManager.createBoard` | Create a new board |
| Configure Board Settings | `ticketManager.configureBoardColumns` | Customise board column visibility |
| Set Board Projects | `ticketManager.setBoardProjects` | Filter boards by project |
| Set Board Types | `ticketManager.setBoardTypes` | Filter boards by issue type |
| Set Board Search Text | `ticketManager.setBoardSearchText` | Free-text search in boards |
| Clear Board Filters | `ticketManager.clearBoardFilters` | Reset all board filters |
| Search Boards | `ticketManager.searchBoards` | Toggle board search input |

### Issues

| Command | ID | Description |
|---------|----|-------------|
| Create Issue | `ticketManager.createIssue` | Create a new issue |
| Change Status | `ticketManager.changeStatus` | Transition an issue to a new status |
| Open Full Issue Details | `ticketManager.openIssueFullDetails` | Open issue details in an editor tab |
| Open External Link | `ticketManager.openInBrowser` | Open the issue in a browser |
| Copy Issue Key | `ticketManager.copyKey` | Copy the issue key to the clipboard |
| Load More | `ticketManager.loadMore` | Load the next page of issues |

### Issue Filtering

| Command | ID | Description |
|---------|----|-------------|
| Set Projects | `ticketManager.setProjects` | Multi-select project filter |
| Set Status Filter | `ticketManager.setStatuses` | Multi-select status filter |
| Set Issue Type Filter | `ticketManager.setIssueTypes` | Multi-select issue type filter |
| Set Search Text | `ticketManager.setSearchText` | Free-text search |
| Toggle Assignee Scope | `ticketManager.toggleAssigneeMode` | Switch between "me" and "all" |
| Set Parent Item Scope | `ticketManager.setParentScope` | Filter issues by parent EPIC |
| Clear Parent Item Scope | `ticketManager.clearParentScope` | Remove parent filter |
| Clear Filters | `ticketManager.clearFilters` | Reset all issue filters |
| Search Issues | `ticketManager.searchIssues` | Toggle issue search input |

### EPICs

| Command | ID | Description |
|---------|----|-------------|
| Create EPIC | `ticketManager.createEpic` | Create a new EPIC |
| Search EPICs | `ticketManager.searchEpics` | Toggle EPIC search input |

### AI Agent & Review

| Command | ID | Description |
|---------|----|-------------|
| Assign to Me | `ticketManager.assignToMe` | Assign the selected issue to yourself |
| Assign to AI Agent | `ticketManager.assignToAi` | Assign the selected issue to an AI agent |
| Unassign AI Agent | `ticketManager.unassignAi` | Remove AI agent assignment |
| Review Ticket with AI | `ticketManager.reviewWithAi` | Post an AI review as a comment on the ticket |
| Local Peer Review (LPR) | `ticketManager.localPeerReview` | Open a full code review, security review, and summary panel |

---

## 10. Settings Reference

All settings are under the `ticketManager` namespace.

### Backend & Connection

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ticketManager.backendMode` | enum | _(none)_ | Active backend: `jira`, `demo`, `file`, `github`, `gitlab` |
| `ticketManager.connectionType` | enum | `"stdio"` | Jira MCP connection type: `stdio` (local process) or `http` (remote) |
| `ticketManager.stdioCommand` | string | `""` | Command to start the local Jira MCP server |
| `ticketManager.stdioArgs` | string[] | `[]` | Arguments for the MCP server command |
| `ticketManager.stdioCwd` | string | `""` | Working directory for the MCP server command |
| `ticketManager.httpUrl` | string | `""` | Base URL for a remote Jira MCP server (HTTP) |

### MCP Auto-Discovery

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `ticketManager.workspaceMcpServerName` | string | `""` | window | MCP server name from `.vscode/mcp.json` |
| `ticketManager.userMcpServerRef` | string | `""` | application | User/profile MCP server reference |

### File Mode

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ticketManager.planFilePath` | string | `""` | Path to the plan file (absolute or workspace-relative) |

### GitHub

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ticketManager.githubPat` | string | `""` | GitHub Personal Access Token |
| `ticketManager.githubUrl` | string | `"https://api.github.com"` | GitHub API base URL |
| `ticketManager.githubOwner` | string | `""` | GitHub organisation or user |

### GitLab

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ticketManager.gitlabUrl` | string | `""` | GitLab instance URL |
| `ticketManager.gitlabConnectionType` | enum | `"api"` | Connection type: `api` (API Key) or `mcp` (GitLab MCP Server) |
| `ticketManager.gitlabApiKey` | string | `""` | GitLab Personal Access Token |
| `ticketManager.gitlabMcpCommand` | string | `""` | Command to start the GitLab MCP server |
| `ticketManager.gitlabMcpArgs` | string[] | `[]` | Arguments for the GitLab MCP server command |

### Request & Performance

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `ticketManager.requestTimeoutMs` | number | `30000` | min 1000 | Timeout for MCP requests (ms) |
| `ticketManager.defaultPageSize` | number | `25` | 5–100 | Issues per page |

### UI Customisation

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ticketManager.jiraBoardListIconColor` | string | `""` | Accent colour for board icons in Jira mode (hex, e.g. `#3b82f6`) |
| `ticketManager.demoBoardListIconColor` | string | `""` | Accent colour for board icons in Demo mode (hex, e.g. `#a855f7`) |
| `ticketManager.fileBoardListIconColor` | string | `""` | Accent colour for board icons in File mode (hex, e.g. `#22c55e`) |

### Feature Flags

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ticketManager.enableNewProject` | boolean | `false` | Enable the New Project wizard (preview) |

### AI Provider

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ticketManager.ai.openaiApiKey` | string | `""` | OpenAI API key for AI agent assignment |
| `ticketManager.ai.claudeApiKey` | string | `""` | Claude/Anthropic API key for AI agent assignment |
| `ticketManager.ai.cursorCliPath` | string | `""` | Path to the Cursor CLI executable |
| `ticketManager.ai.copilotEnabled` | boolean | `false` | Enable the GitHub Copilot SDK using existing machine auth |
| `ticketManager.ai.copilotCliPath` | string | `""` | Legacy compatibility override for the runtime used by the GitHub Copilot SDK |
| `ticketManager.ai.defaultProvider` | enum | `"none"` | Default AI provider: `openai`, `claude`, `cursor-cli`, `copilot-cli`, `none` |
| `ticketManager.ai.openaiAgentName` | string | `""` | Display name for the OpenAI agent |
| `ticketManager.ai.claudeAgentName` | string | `""` | Display name for the Claude agent |
| `ticketManager.ai.mentionName` | string | `""` | Custom @mention name for AI replies in comments (e.g. `daveai`). Both `@copilot` and `@<name>` trigger replies |

---

## 11. Keyboard Shortcuts

No custom keybindings are defined by the extension. All commands are accessible through:

- The **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`) — search for "Ticket Manager"
- **Sidebar toolbar buttons** and **context menus**
- **Inline actions** on list items

You can bind any Ticket Manager command to a custom shortcut via **File → Preferences → Keyboard Shortcuts**.

---

## 12. Development Guidelines

### Webview Panel Creation (CRITICAL)

VS Code Insiders requires `panel.webview.html` to be set **synchronously** — in the same
execution block — immediately after `createWebviewPanel()`. Any `await` between panel
creation and the html assignment will cause the webview to render blank in VS Code Insiders
(standard VS Code is more forgiving but the same pattern should always be followed).

**Wrong — blank in Insiders:**
```typescript
const panel = vscode.window.createWebviewPanel(...);
await fetchData();              // async gap breaks rendering
panel.webview.html = getHtml(); // too late — blank forever
```

**Correct:**
```typescript
await fetchData();              // do all async work first
const panel = vscode.window.createWebviewPanel(...);
panel.webview.html = getHtml(); // set immediately after creation
```

**Refreshing panels:** To update a panel with new data, dispose the existing panel and
create a new one rather than setting `webview.html` on an existing panel after async work.
See `IssueDetailPanelManager.createPanelWithHtml()` and `refreshIfShowing()` for the
reference implementation.

### Content Security Policy

All webview panels and sidebar views should use this CSP pattern:
```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
```
- Use `<style>` **without** a nonce attribute
- Use `<script nonce="${nonce}">` for all script blocks

---

## 13. Known Limitations

| Area | Limitation |
|------|------------|
| **GitHub backend** | Configuration UI and settings are ready, but the backend service is not yet implemented. Selecting GitHub mode will not load issues or boards. |
| **GitLab backend** | Configuration UI and settings are ready, but the backend service is not yet implemented. Selecting GitLab mode will not load issues or boards. |
| **AI agent assignment** | AI session tracking is local to VS Code workspace state. `@copilot` and custom `@mention` replies are only triggered for comments submitted through this extension UI — external ticket comments are not monitored. Copilot agent sessions may appear in Copilot history because the SDK creates real resumable sessions. |
| **New Project wizard** | Preview feature, disabled by default. AI review uses mock data in the current implementation. |
| **File mode** | Issues are stored in a single JSONC file. Very large plan files may affect performance. |
| **Board drag-and-drop** | Cross-column transitions are subject to the backend's workflow rules and may be rejected. Intra-column card reordering is board-local only and not synced to the backend. |
| **Local Peer Review** | LPR quality depends on the ticket description and the AI provider used. Code-level analysis is limited to what the AI can infer from the ticket context (no direct file access in LPR mode). |

---

_Generated for Ticket Manager v0.0.1_
