# Ticket Manager

Ticket Manager is a VS Code extension that provides a unified workflow for issue tracking, board management, and AI-assisted delivery from a single sidebar experience.

Current extension version: 0.0.26

## What It Does

- Adds a Tickets Activity Bar container with setup, board, issue, EPIC, session, and details views.
- Supports multi-connection setup through Connections & Boards, where users add connections and explicitly track boards.
- Routes issue and board actions through the currently selected tracked board connection.
- Includes AI assignment, AI session management, local peer review, delivery workflow automation, and Jira polling hooks.

## Core Views

- Configure Project
- Boards (classic mode)
- Work Mode (preview board-centric mode)
- EPICs
- My Issues
- Sessions
- Issue Details

## Backend Modes

Configured with ticketManager.backendMode (and per-connection mode in ticketManager.connections).

| Mode | Value | Status |
| --- | --- | --- |
| Jira Cloud / Jira API | jiraapi | Primary Jira mode. Supports Jira Cloud OAuth site connection fields plus direct Jira API settings and board/issue operations. |
| Demo | demo | Built-in sample data. |
| GitHub | github | Configuration is available; full issue/board parity is not implemented yet. |
| GitLab | gitlab | Configuration plus GitLab delivery/MR helpers exist; issue/board behavior differs from Jira mode. |
| Live Folder | livefolder | Reads markdown feature plans from disk (optional write support). |
| User Workspace | userworkspace | Local workspace/user-backed issue storage. |

Notes:

- Legacy/internal paths still reference additional historical modes (for compatibility), but the supported configuration modes above are the active ones exposed in settings.
- Boards shown in the main Boards views are based on tracked boards from Connections & Boards.

## Jira Configuration

### Jira OAuth and site metadata

- ticketManager.jiraOAuthClientId
- ticketManager.jiraOAuthScopes
- ticketManager.jiraCloudId
- ticketManager.jiraCloudSiteName
- ticketManager.jiraCloudSiteUrl

### Jira API settings

- ticketManager.jiraApiBaseUrl
- ticketManager.jiraApiToken
- ticketManager.jiraApiEpicKey
- ticketManager.jiraApiEpicBoardName
- ticketManager.jiraApiBoardJql
- ticketManager.jiraApiBoardName

### Jira polling and delivery settings

- ticketManager.jiraPolling.enabled
- ticketManager.jiraPolling.requiredLabel
- ticketManager.jiraPolling.clarificationAnalysis
- ticketManager.delivery.defaultBaseBranch
- ticketManager.delivery.autoMergeSubTasks
- ticketManager.ai.deliveryWorkflowEnabled
- ticketManager.ai.deliveryPublishCommand
- ticketManager.ai.deliveryArtifactPattern
- ticketManager.ai.deliveryAgentWorkflowPath
- ticketManager.ai.deliveryAgentWorkflowUrl
- ticketManager.ai.deliverySummaryTemplate
- ticketManager.ai.deliveryFailureTemplate

Useful commands:

- Ticket Manager: Open Connections & Boards
- Ticket Manager: Add Connection
- Ticket Manager: Add Tracked Board
- Ticket Manager: Disconnect Jira Cloud
- Ticket Manager: Link Jira API Epic
- Ticket Manager: Link Jira API Board Query
- Ticket Manager: Start Sub-Task Delivery

## Live Folder Markdown Format

Live Folder mode reads markdown issue files from a plans/features style tree.

Expected layout:

- plans/features/feature-NN-name/feature.md
- plans/features/feature-NN-name/story-NN-M-name.md
- plans/features/feature-NN-name/task-NN-M-name.md
- plans/features/feature-NN-name/bug-NN-M-name.md

Supported issue types:

- Feature
- Story
- Task
- Bug

Common fields/sections include Status, Created, Type, Priority, Description, Dependencies, Comments, and bug-specific reproduction/expected/actual behavior sections.

## Boards and Issue UX

- Board search and filter commands
- Project/type board filters
- Board column configuration
- Status color mapping and priority color bars
- Issue card interactions (status changes, assignment actions)
- Issue details with comments, transitions, parent linkage, and attachments where supported by backend

## AI and Sessions

AI providers supported by settings and workflows:

- openai
- claude
- cursor-cli
- copilot-cli
- claude-cli

AI-related commands include:

- Ticket Manager: Configure AI
- Ticket Manager: Delegate to Copilot Agent
- Ticket Manager: Start Claude Code Session
- Ticket Manager: Assign Workflow Pack
- Ticket Manager: View AI Session
- Ticket Manager: Abort Agent Session
- Ticket Manager: Review Ticket with AI
- Ticket Manager: Local Peer Review

## Development

### Build

```powershell
npm install
npm run compile
```

Press F5 in VS Code to open the Extension Development Host.

### Tests

```powershell
npm test
```

### Package

```powershell
npm run package
```

or

```powershell
npx @vscode/vsce package
```

## Local utility scripts

- npm run open:ticket-manager
- npm run install:vsix
- npm run install:code
- npm run install:insiders
- npm run install:cursor

## Migration documentation

See docs/migrations/live-folder-to-jira-gitlab-github.md for the migration plan.

## Known limitations

- GitHub backend is configuration-first and not yet full issue/board parity.
- GitLab issue/board behavior is not the same as Jira model behavior.
- Some advanced delivery and automation flows require Jira/GitLab settings, credentials, and workflow alignment to be configured correctly.
