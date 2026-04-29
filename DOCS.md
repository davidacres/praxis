# Ticket Manager — Documentation

> **Version:** 0.0.20
> VS Code extension for issue/board management, local plans, Jira integration, and AI delivery sessions.

## Table of Contents

1. [Overview](#1-overview)
2. [Install and Develop](#2-install-and-develop)
3. [First-Time Setup](#3-first-time-setup)
4. [Backend Modes](#4-backend-modes)
5. [Views](#5-views)
6. [Boards](#6-boards)
7. [Live Folder Markdown](#7-live-folder-markdown)
8. [AI, Sessions, and Delivery](#8-ai-sessions-and-delivery)
9. [Commands Reference](#9-commands-reference)
10. [Settings Reference](#10-settings-reference)
11. [Migration Plan](#11-migration-plan)
12. [Development Guidelines](#12-development-guidelines)
13. [Known Limitations](#13-known-limitations)

## 1. Overview

Ticket Manager adds a `Tickets` Activity Bar container to VS Code. It gives a unified UI for setup, boards, EPICs, issue lists, issue details, and AI agent sessions while routing data through the active backend.

### Supported backends

| Backend | Mode | Current state |
| --- | --- | --- |
| Jira via MCP | `jira` | Connects to Jira through a stdio or HTTP MCP server. |
| Jira API | `jiraapi` | Direct Jira Server/Data Center API mode with PAT auth, linked epic support, transitions, comments, attachments, and polling/delivery integration. |
| Demo | `demo` | Built-in sample data for evaluation and tests. |
| File/Plan | `file` | Local JSON/JSONC plan file. |
| Live Folder | `livefolder` | Markdown plan tree read live from disk, optionally writable. |
| User Workspace | `userworkspace` | Local workspace/user-backed issue store. |
| GitHub | `github` | Setup/settings exist; a GitHub issue/board backend service is not currently present in `src`. |
| GitLab | `gitlab` | Setup/settings and GitLab MR delivery helpers exist; full issue/board behavior differs from the Jira/File service model. |

## 2. Install and Develop

### From source

```powershell
npm install
npm run compile
```

Press `F5` to launch an Extension Development Host.

### Install locally

```powershell
npm run install:vsix
npm run install:vsix -- --target=code
npm run install:vsix -- --target=insiders
npm run install:code
npm run install:insiders
npm run install:cursor
```

### Test

```powershell
npm test
```

Docs-only changes do not normally require the full extension test suite.

## 3. First-Time Setup

When the extension activates, it resolves the active backend and configuration. If the current folder is closed, no valid configuration exists, or the selected backend is incomplete, the extension reveals the **Configure Project** setup view instead of leaving the sidebar blank.

Use either:

- `Ticket Manager: Configure Project`
- `Ticket Manager: Set Backend Mode`
- `Ticket Manager: Open Settings`

After setup, the sidebar shows **Boards**, **EPICs**, **My Issues**, **Active Sessions**, and **Issue Details**.

## 4. Backend Modes

### Jira via MCP (`jira`)

Use this mode when a Jira MCP server is available.

| Setting | Description |
| --- | --- |
| `ticketManager.connectionType` | `stdio` for a local process or `http` for a remote MCP server. |
| `ticketManager.stdioCommand` | Local command used to start the MCP server. |
| `ticketManager.stdioArgs` | Arguments for the local MCP server. |
| `ticketManager.stdioCwd` | Optional local MCP working directory. |
| `ticketManager.httpUrl` | Remote streamable HTTP MCP URL. |

MCP configuration can be imported from workspace `.vscode\mcp.json`, VS Code user/profile config, VS Code Insiders user/profile config, or Cursor config.

### Jira API (`jiraapi`)

Use this mode for direct Jira Server/Data Center access.

| Setting | Description |
| --- | --- |
| `ticketManager.jiraApiBaseUrl` | Jira base URL. |
| `ticketManager.jiraApiToken` | Personal access token; falls back to `JIRA_TOKEN` when empty. |
| `ticketManager.jiraApiEpicKey` | Optional workspace-level epic. New Jira API issues use it as the default parent. |

Jira API mode supports issue loading, metadata, comments, transitions, attachments, sub-task creation, linked-epic sync, and delivery polling. Boards are derived from Jira/epic metadata and cannot be created, edited, or deleted from the extension.

Use:

- `Ticket Manager: Link Jira API Epic`
- `Ticket Manager: Migrate Live Folder to Jira API`
- `Ticket Manager: Start Sub-Task Delivery`

### Demo (`demo`)

Demo mode requires no settings and provides sample projects, issue types, statuses, parent-child relationships, boards, and simulated transition failures.

### File/Plan (`file`)

File mode stores projects, statuses, transitions, boards, and issues in a JSON/JSONC plan file.

Auto-discovery order:

1. `ticket-plan.jsonc`
2. `ticket-plan.json`
3. `.vscode\ticket-plan.jsonc`
4. `.vscode\ticket-plan.json`

Set `ticketManager.planFilePath` to choose a specific file. `Ticket Manager: Import Plan from Markdown Features` can convert structured markdown into plan data.

### Live Folder (`livefolder`)

Live Folder mode reads a markdown tree directly from disk. Set:

- `ticketManager.liveFolderPath`
- `ticketManager.liveFolderProjectKey`
- `ticketManager.liveFolderProjectName`
- `ticketManager.liveFolderAllowIssueCreation`

The path can point to a `plans` folder, a `features` folder, or a parent folder. If issue creation is disabled, the extension treats markdown as read-only.

### User Workspace (`userworkspace`)

User Workspace mode stores local issue data in VS Code state for the active user/workspace. It is useful for local tracking when neither Jira nor plan files should be used.

### GitHub (`github`)

Settings and setup UI:

- `ticketManager.githubPat`
- `ticketManager.githubUrl`
- `ticketManager.githubOwner`

A GitHub issue/board backend service is not currently present in `src`, so the migration plan treats GitHub as a future backend implementation target.

### GitLab (`gitlab`)

Settings and setup UI:

- `ticketManager.gitlabUrl`
- `ticketManager.gitlabConnectionType`
- `ticketManager.gitlabApiKey`
- `ticketManager.gitlabMcpCommand`
- `ticketManager.gitlabMcpArgs`

The repository includes GitLab API helpers for merge-request delivery and discussion polling. That support is not the same as a complete GitLab issue/board backend, so migration work must reconcile the model differences.

## 5. Views

| View | Purpose |
| --- | --- |
| Configure Project | Backend and credential setup, revealed automatically when configuration is missing. |
| Boards | Board list, search, filters, create issue, and board settings. |
| EPICs | Parent item browsing, EPIC creation, search, and parent scoping. |
| My Issues | Main issue list with filters and pagination. |
| Active Sessions | Assigned AI work, Copilot sessions, Claude Code sessions, status, and session details. |
| Issue Details | Metadata, description, comments, transitions, parent links, attachments, AI assignment, workflow packs, and full details tab. |

Issue Details includes metadata controls for status, priority, severity/model where supported by the backend, and quick actions for assignment and AI workflows.

## 6. Boards

Board features include:

- board list/search toggle
- list group ordering
- project, issue type, search text, and max-age filters
- board editor tabs with status columns
- configurable visible columns
- status color styling
- priority bars controlled by `ticketManager.priorityColors`
- issue-type tinting
- swim lanes where backend data provides grouping
- selected-card highlighting
- local intra-column card ordering for visual priority

Useful commands:

- `Ticket Manager: Set Board Projects`
- `Ticket Manager: Set Board Types`
- `Ticket Manager: Set Board Search Text`
- `Ticket Manager: Clear Board Filters`
- `Ticket Manager: Configure Board Settings`
- `Ticket Manager: Search Boards`

## 7. Live Folder Markdown

Expected tree:

```text
plans\
  features\
    feature-01-name\
      feature.md
      story-01-1-name.md
      task-01-2-name.md
      bug-01-3-name.md
```

Supported issue types are `Feature`, `Story`, `Task`, and `Bug`.

Canonical fields:

- `Status`
- `Created`
- `Type`
- `Priority`
- `Model` when a default model is configured for newly created issues
- `Parent` on created child issues
- `Severity` and `Reported By` for bugs

Canonical sections:

- `Description`
- `Items` for features
- `Steps to Reproduce`, `Expected Behavior`, and `Actual Behavior` for bugs
- `Dependencies`
- `Comments`

`Ticket Manager: Import Markdown Files to Template Format` upgrades existing markdown to the canonical template without intentionally overwriting content. `Ticket Manager: Migrate Live Folder to Jira API` migrates the current Live Folder feature into Jira API mode.

## 8. AI, Sessions, and Delivery

### Providers and naming

AI settings live under `ticketManager.ai.*`.

| Setting | Description |
| --- | --- |
| `ticketManager.ai.openaiApiKey` | OpenAI API key. |
| `ticketManager.ai.claudeApiKey` | Claude/Anthropic API key. |
| `ticketManager.ai.cursorCliPath` | Cursor CLI path. |
| `ticketManager.ai.copilotEnabled` | Enables the GitHub Copilot SDK. |
| `ticketManager.ai.copilotCliPath` | Legacy runtime override for Copilot SDK debugging. |
| `ticketManager.ai.copilotAgentName` | Display and @mention name for Copilot. |
| `ticketManager.ai.claudeCliPath` | Claude Code CLI path. |
| `ticketManager.ai.defaultProvider` | `openai`, `claude`, `cursor-cli`, `copilot-cli`, `claude-cli`, or `none`. |
| `ticketManager.ai.defaultModel` | Model written to newly created live-folder markdown issues when set. |
| `ticketManager.ai.openaiAgentName` | Display name for OpenAI. |
| `ticketManager.ai.claudeAgentName` | Display name for Claude. |
| `ticketManager.ai.verboseActivityFeed` | Shows lower-level events in session activity. |

The old `ticketManager.ai.mentionName` setting is legacy/hidden and is not contributed by `package.json`. Current mention behavior derives from the active/default agent label, with `ticketManager.ai.copilotAgentName` customizing Copilot.

### Sessions

Active Sessions tracks assigned AI work and live agent runs. It supports viewing a session, following progress, and aborting active runs.

Commands:

- `Ticket Manager: Configure AI`
- `Ticket Manager: Delegate to Copilot Agent`
- `Ticket Manager: Start Claude Code Session`
- `Ticket Manager: Assign Workflow Pack`
- `Ticket Manager: View AI Session`
- `Ticket Manager: Abort Agent Session`
- `Ticket Manager: Assign to AI Agent`
- `Ticket Manager: Abandon AI Session`

### Jira polling and delivery

Polling/delivery settings:

- `ticketManager.jiraPolling.enabled`
- `ticketManager.jiraPolling.requiredLabel`
- `ticketManager.jiraPolling.clarificationAnalysis`
- `ticketManager.delivery.defaultBaseBranch`
- `ticketManager.delivery.autoMergeSubTasks`
- `ticketManager.ai.deliveryWorkflowEnabled`
- `ticketManager.ai.deliveryPublishCommand`
- `ticketManager.ai.deliveryArtifactPattern`
- `ticketManager.ai.deliveryAgentWorkflowPath`
- `ticketManager.ai.deliveryAgentWorkflowUrl`
- `ticketManager.ai.deliverySummaryTemplate`
- `ticketManager.ai.deliveryFailureTemplate`

In Jira API mode, linked-epic tasks are synced regardless of the polling label; the label gates which tasks are eligible for AI execution.

## 9. Commands Reference

### Core and setup

| Command | ID |
| --- | --- |
| Refresh | `ticketManager.refresh` |
| Configure Jira MCP Connection | `ticketManager.configureConnection` |
| Check Connection | `ticketManager.checkConnection` |
| Set Backend Mode | `ticketManager.setBackendMode` |
| Configure Project | `ticketManager.openSetup` |
| Open Settings | `ticketManager.openSettings` |
| Use Workspace MCP Configuration | `ticketManager.importWorkspaceMcpConfig` |
| Use User/Profile MCP Configuration | `ticketManager.importUserMcpConfig` |

### Project, import, and migration

| Command | ID |
| --- | --- |
| New Project | `ticketManager.newProject` |
| Import Plan from Markdown Features | `ticketManager.importMarkdownFeaturePlan` |
| Import Markdown Files to Template Format | `ticketManager.importMarkdownFiles` |
| Migrate Live Folder to Jira API | `ticketManager.migrateLiveFolderToJiraApi` |
| Link Jira API Epic | `ticketManager.linkJiraApiEpic` |

### Boards

| Command | ID |
| --- | --- |
| Open Board | `ticketManager.openBoard` |
| Create Board | `ticketManager.createBoard` |
| Configure Board Settings | `ticketManager.configureBoardColumns` |
| Set Board Projects | `ticketManager.setBoardProjects` |
| Set Board Types | `ticketManager.setBoardTypes` |
| Set Board Search Text | `ticketManager.setBoardSearchText` |
| Clear Board Filters | `ticketManager.clearBoardFilters` |
| Search Boards | `ticketManager.searchBoards` |

### Issues and filters

| Command | ID |
| --- | --- |
| Create Issue | `ticketManager.createIssue` |
| Search Issues | `ticketManager.searchIssues` |
| Set Projects | `ticketManager.setProjects` |
| Set Status Filter | `ticketManager.setStatuses` |
| Set Issue Type Filter | `ticketManager.setIssueTypes` |
| Set Search Text | `ticketManager.setSearchText` |
| Toggle Assignee Scope | `ticketManager.toggleAssigneeMode` |
| Set Parent Item Scope | `ticketManager.setParentScope` |
| Clear Parent Item Scope | `ticketManager.clearParentScope` |
| Clear Filters | `ticketManager.clearFilters` |
| Change Status | `ticketManager.changeStatus` |
| Open Full Issue Details | `ticketManager.openIssueFullDetails` |
| Open External Link | `ticketManager.openInBrowser` |
| Copy Issue Key | `ticketManager.copyKey` |
| Load More | `ticketManager.loadMore` |
| Assign to Me | `ticketManager.assignToMe` |

### EPICs and AI

| Command | ID |
| --- | --- |
| Create EPIC | `ticketManager.createEpic` |
| Search EPICs | `ticketManager.searchEpics` |
| Start Sub-Task Delivery | `ticketManager.startSubTaskDelivery` |
| Configure AI | `ticketManager.configureAi` |
| Delegate to Copilot Agent | `ticketManager.delegateToCopilot` |
| Start Claude Code Session | `ticketManager.startClaudeSession` |
| Assign Workflow Pack | `ticketManager.assignWorkflowPack` |
| View AI Session | `ticketManager.viewAgentSession` |
| Abort Agent Session | `ticketManager.abortAgentSession` |
| Assign to AI Agent | `ticketManager.assignToAi` |
| Abandon AI Session | `ticketManager.unassignAi` |
| Review Ticket with AI | `ticketManager.reviewWithAi` |
| Local Peer Review (LPR) | `ticketManager.localPeerReview` |

## 10. Settings Reference

### Backend and Jira

- `ticketManager.backendMode`
- `ticketManager.connectionType`
- `ticketManager.stdioCommand`
- `ticketManager.stdioArgs`
- `ticketManager.stdioCwd`
- `ticketManager.httpUrl`
- `ticketManager.jiraApiBaseUrl`
- `ticketManager.jiraApiToken`
- `ticketManager.jiraApiEpicKey`
- `ticketManager.workspaceMcpServerName`
- `ticketManager.userMcpServerRef`

### Local and hosted backends

- `ticketManager.planFilePath`
- `ticketManager.liveFolderPath`
- `ticketManager.liveFolderProjectKey`
- `ticketManager.liveFolderProjectName`
- `ticketManager.liveFolderAllowIssueCreation`
- `ticketManager.githubPat`
- `ticketManager.githubUrl`
- `ticketManager.githubOwner`
- `ticketManager.gitlabUrl`
- `ticketManager.gitlabConnectionType`
- `ticketManager.gitlabApiKey`
- `ticketManager.gitlabMcpCommand`
- `ticketManager.gitlabMcpArgs`

### Performance and UI

- `ticketManager.requestTimeoutMs`
- `ticketManager.defaultPageSize`
- `ticketManager.priorityColors`
- `ticketManager.jiraBoardListIconColor`
- `ticketManager.demoBoardListIconColor`
- `ticketManager.fileBoardListIconColor`
- `ticketManager.liveFolderBoardListIconColor`
- `ticketManager.enableNewProject`

### AI and delivery

- `ticketManager.ai.openaiApiKey`
- `ticketManager.ai.claudeApiKey`
- `ticketManager.ai.cursorCliPath`
- `ticketManager.ai.copilotEnabled`
- `ticketManager.ai.copilotCliPath`
- `ticketManager.ai.copilotAgentName`
- `ticketManager.ai.claudeCliPath`
- `ticketManager.ai.defaultProvider`
- `ticketManager.ai.defaultModel`
- `ticketManager.ai.openaiAgentName`
- `ticketManager.ai.claudeAgentName`
- `ticketManager.ai.verboseActivityFeed`
- `ticketManager.ai.deliveryWorkflowEnabled`
- `ticketManager.ai.deliveryPublishCommand`
- `ticketManager.ai.deliveryArtifactPattern`
- `ticketManager.ai.deliveryAgentWorkflowPath`
- `ticketManager.ai.deliveryAgentWorkflowUrl`
- `ticketManager.ai.deliverySummaryTemplate`
- `ticketManager.ai.deliveryFailureTemplate`
- `ticketManager.jiraPolling.enabled`
- `ticketManager.jiraPolling.requiredLabel`
- `ticketManager.jiraPolling.clarificationAnalysis`
- `ticketManager.delivery.defaultBaseBranch`
- `ticketManager.delivery.autoMergeSubTasks`

## 11. Migration Plan

The implementation plan for expanding Live Folder migration to Jira API, GitLab, and GitHub is in [docs\migrations\live-folder-to-jira-gitlab-github.md](docs/migrations/live-folder-to-jira-gitlab-github.md).

## 12. Development Guidelines

### Webview panel creation

For VS Code Insiders, `panel.webview.html` must be assigned synchronously in the same execution block immediately after `createWebviewPanel()`. Do all async work before creating the panel. Refresh panels by disposing and recreating them instead of assigning HTML after an async gap.

### CSP

Use:

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
```

Use `<style>` without a nonce and `<script nonce="${nonce}">` for script blocks.

## 13. Known Limitations

| Area | Limitation |
| --- | --- |
| GitHub | Setup/settings exist, but no GitHub issue/board backend service is currently present in `src`. |
| GitLab | GitLab API helpers support delivery/MR workflows; full GitLab issue/board parity still needs design. |
| Jira API boards | Derived from Jira/linked-epic metadata; board create/edit/delete is not supported. |
| Live Folder | Markdown writes are controlled by `ticketManager.liveFolderAllowIssueCreation`; disable it for read-only use. |
| AI comments | Extension-triggered @mentions are handled through the Ticket Manager UI and active/default agent naming. External ticket comments are not generally monitored except by the polling workflows that explicitly implement reply handling. |
| New Project wizard | Preview feature disabled by default. |
