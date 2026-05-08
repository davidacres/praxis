# Ticket Manager

Ticket Manager is a VS Code extension for browsing issues, boards, EPICs, issue details, and AI delivery sessions from a single `Tickets` Activity Bar container.

Current package version: `0.0.20`.

## Highlights

- Setup view that is revealed on startup when no folder/configuration is available.
- Backend modes: `jira`, `jiraapi`, `demo`, `file`, `github`, `gitlab`, `livefolder`, and `userworkspace`.
- Sidebar views: **Configure Project**, **Boards**, **EPICs**, **My Issues**, **Active Sessions**, and **Issue Details**.
- Jira MCP and direct Jira Server/Data Center API connectivity.
- Jira API linked-epic flow, Live Folder migration command, sub-task delivery, attachments, and polling-driven AI delivery.
- File and Live Folder modes for local project plans.
- Board list/search/filtering plus editor boards with status columns, swim lanes, priority bars, issue-type tinting, status colors, and card ordering.
- AI assignment, Copilot delegation, Claude Code sessions, workflow packs, session viewing, and abort controls.

## Development

```powershell
npm install
npm run compile
```

Press `F5` in VS Code to launch the extension development host.

To open a shell-like VS Code window (no folder) with your normal signed-in profile, focused on Ticket Manager:

```powershell
npm run open:ticket-manager
```

Optionally pass a path to include in the shell workspace:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-ticket-manager-vscode.ps1 -OpenPath C:\path\to\workspace
```

## Testing

```powershell
npm test
```

The integration suite covers extension activation, command registration, connected/demo/file backends, board rendering and filters, parent scoping, status transitions, and capability validation. Docs-only changes normally do not require a full test run.

## Backend Modes

Switch modes with `Ticket Manager: Set Backend Mode` or `ticketManager.backendMode`.

| Mode | Setting value | Status |
| --- | --- | --- |
| Jira via MCP | `jira` | Uses a Jira MCP server over stdio or HTTP. |
| Jira API | `jiraapi` | Direct Jira Server/Data Center API mode with PAT auth, linked epic, issue creation, transitions, comments, attachments, and delivery polling. |
| Demo | `demo` | Built-in sample projects, issues, boards, and transitions. |
| Plan File | `file` | JSON/JSONC plan file stored in the workspace. |
| Live Folder | `livefolder` | Markdown plans tree read live from disk, with optional markdown issue creation. |
| User Workspace | `userworkspace` | Workspace/user-scoped local issue store. |
| GitHub | `github` | Settings and setup UI exist; a GitHub issue/board backend service is not currently present in `src`. |
| GitLab | `gitlab` | Settings/setup and GitLab merge-request delivery helpers exist, but the issue/board model differs from the Jira/File service model. |

### Jira API

Jira API mode connects directly to Jira Server/Data Center:

- `ticketManager.jiraApiBaseUrl`
- `ticketManager.jiraApiToken` or `JIRA_TOKEN`
- `ticketManager.jiraApiEpicKey`
- `ticketManager.jiraApiEpicBoardName`
- `ticketManager.jiraApiBoardJql`
- `ticketManager.jiraApiBoardName`

Use:

- `Ticket Manager: Link Jira API Epic` to associate the workspace with an epic.
- `Ticket Manager: Link Jira API Board Query` to associate the workspace with a JQL-backed board.
- `Ticket Manager: Migrate Live Folder to Jira API` to migrate the current Live Folder feature into Jira API.
- `Ticket Manager: Start Sub-Task Delivery` to start the polling/delivery workflow for Jira sub-tasks.

Jira API boards are derived from linked-epic work and/or a configured JQL query plus Jira board/status metadata; board creation/edit/delete is not supported in this mode.

### Jira via MCP

Configure a local `stdio` server or remote `http` MCP server with:

- `ticketManager.connectionType`
- `ticketManager.stdioCommand`
- `ticketManager.stdioArgs`
- `ticketManager.stdioCwd`
- `ticketManager.httpUrl`

The extension can import Jira MCP settings from workspace `.vscode\mcp.json`, VS Code user/profile MCP config, VS Code Insiders user/profile config, or Cursor MCP config.

Useful commands:

- `Ticket Manager: Configure Jira MCP Connection`
- `Ticket Manager: Use Workspace MCP Configuration`
- `Ticket Manager: Use User/Profile MCP Configuration`
- `Ticket Manager: Check Connection`

### File Mode

File mode auto-discovers:

- `ticket-plan.jsonc`
- `ticket-plan.json`
- `.vscode\ticket-plan.jsonc`
- `.vscode\ticket-plan.json`

Set `ticketManager.planFilePath` for a specific plan file. The starter plan includes projects, workflow statuses, transitions, boards, issue hierarchy, and persisted status changes.

### Live Folder Mode

Live Folder mode reads a markdown plans tree from a `plans` folder, `features` folder, or parent folder.

Expected layout:

- `plans\features\feature-NN-name\feature.md`
- `plans\features\feature-NN-name\story-NN-M-name.md`
- `plans\features\feature-NN-name\task-NN-M-name.md`
- `plans\features\feature-NN-name\bug-NN-M-name.md`

The canonical markdown template supports `Feature`, `Story`, `Task`, and `Bug` with:

- fields: `Status`, `Created`, `Type`, `Priority`, optional `Model`
- bug fields: `Severity`, `Reported By`
- sections: `Description`, `Dependencies`, `Comments`
- feature section: `Items`
- bug sections: `Steps to Reproduce`, `Expected Behavior`, `Actual Behavior`

`Ticket Manager: Import Markdown Files to Template Format` normalizes markdown to the template. `ticketManager.liveFolderAllowIssueCreation` controls whether the extension can create or update markdown issue files; disable it for read-only use.

## Sidebar Views

- **Configure Project**: setup UI shown when the active folder or settings are not configured.
- **Boards**: board list, search, project/type filters, board settings, and board tabs.
- **EPICs**: parent issue browsing, creation, search, and parent scoping.
- **My Issues**: issue list with project/status/type/search/assignee/parent filters and pagination.
- **Active Sessions**: assigned AI work and live agent runs.
- **Issue Details**: metadata, description, comments, transitions, attachments, parent links, AI assignment, workflow packs, and full details tab.

## Boards

Boards support:

- list/search toggle and list group ordering
- project, issue-type, search, and max-age filtering
- configurable columns and status colors
- priority indicator bars controlled by `ticketManager.priorityColors`
- issue-type tinting and selected-card highlighting
- swim lanes and local intra-column priority ordering

Board commands include `Set Board Projects`, `Set Board Types`, `Set Board Search Text`, `Clear Board Filters`, and `Configure Board Settings`.

## AI and Delivery

AI settings are under `ticketManager.ai.*`. Providers include OpenAI, Claude, Cursor CLI, GitHub Copilot SDK, and Claude Code CLI. `ticketManager.ai.copilotAgentName` customizes the Copilot display and @mention name; otherwise the active/default agent label is used. The legacy `ticketManager.ai.mentionName` setting is no longer contributed.

Important commands:

- `Ticket Manager: Configure AI`
- `Ticket Manager: Assign Workflow Pack`
- `Ticket Manager: Delegate to Copilot Agent`
- `Ticket Manager: Start Claude Code Session`
- `Ticket Manager: View AI Session`
- `Ticket Manager: Abort Agent Session`
- `Ticket Manager: Review Ticket with AI`
- `Ticket Manager: Local Peer Review (LPR)`

Jira polling and delivery settings include:

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

## Migration Planning

The implementation plan for migrating Live Folder content into Jira API, GitLab, and GitHub is in [docs\migrations\live-folder-to-jira-gitlab-github.md](docs/migrations/live-folder-to-jira-gitlab-github.md).

## Packaging

```powershell
npx @vscode/vsce package
```

This creates a `.vsix` package that can be installed locally with VS Code's **Install from VSIX...** command.

## Windows Smoke Checklist

1. Run `npm run compile`.
2. Press `F5` to open the Extension Development Host.
3. Confirm that the `Tickets` Activity Bar icon appears.
4. With no valid config, confirm **Configure Project** is revealed.
5. Switch among Jira MCP, Jira API, Demo, File, Live Folder, and User Workspace modes.
6. Verify **Boards**, **EPICs**, **My Issues**, **Active Sessions**, and **Issue Details** load for configured modes.
7. In Live Folder mode, verify markdown discovery and optional issue creation controlled by `ticketManager.liveFolderAllowIssueCreation`.
8. In Jira API mode, verify connection, linked epic, issue loading, transitions, comments, and attachments if credentials are available.
