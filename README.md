# Ticket Manager

Ticket Manager is a VS Code extension for working with issues and boards through a generic app surface. It supports four runtime modes:

- `jira`: Jira via MCP mode through a Jira MCP server
- `demo`: built-in sample data with no external service
- `file`: a workspace plan file containing features, stories, tasks, bugs, statuses, and boards
- `livefolder`: a markdown plans folder that is read live from disk

## Features

- Activity Bar container for issues, boards, and details
- Issue list with filters for projects, statuses, item types, text, assignee scope, and parent item scope
- Boards view with configurable filters and per-board column customization
- Board editor tab with drag-and-drop status transitions
- Issue details sidebar plus a full issue details tab
- File mode with auto-discovery or creation of a `ticket-plan.jsonc` plan file
- Live Folder mode with discovery of markdown plans plus optional markdown issue creation
- Injectable backend service layer so the UI can switch between connected, demo, and file-backed implementations
- Diagnostics for missing configuration, missing capabilities, and empty access

## Development

```sh
npm install
npm run compile
```

Press `F5` in VS Code to launch the extension development host.

## Testing

```sh
npm test
```

The integration suite launches the extension in an Extension Development Host and verifies:

- extension activation and command registration
- connected backend loading through the fake MCP server
- demo mode loading
- file mode loading and persisted status transitions
- board loading, board filters, and board panel rendering
- parent item scoping
- successful and rejected transitions
- capability validation

## Backend Modes

Ticket Manager starts by asking which mode to use when no mode is configured yet.

Switch between modes with:

- `Ticket Manager: Set Backend Mode`
- `ticketManager.backendMode`

### Jira via MCP

When Jira via MCP mode is active, configure either:

- a local `stdio` Jira MCP server
- a remote `http` Jira MCP server

Ticket Manager can also reuse Jira MCP servers from existing editor config in this order when no manual connected configuration is set:

- workspace `.vscode/mcp.json`
- VS Code user config at `%APPDATA%\Code\User\mcp.json`
- VS Code profile configs under `%APPDATA%\Code\User\profiles\*\mcp.json`
- VS Code Insiders user config at `%APPDATA%\Code - Insiders\User\mcp.json`
- VS Code Insiders profile configs under `%APPDATA%\Code - Insiders\User\profiles\*\mcp.json`
- Cursor global config at `~/.cursor/mcp.json`

Useful commands:

- `Ticket Manager: Configure Jira MCP Connection`
- `Ticket Manager: Use Workspace MCP Configuration`
- `Ticket Manager: Use User/Profile MCP Configuration`
- `Ticket Manager: Check Connection`

### File Mode

File mode looks for a plan file in the workspace. It currently auto-discovers:

- `ticket-plan.jsonc`
- `ticket-plan.json`
- `.vscode/ticket-plan.jsonc`
- `.vscode/ticket-plan.json`

If no file exists, the extension can prompt you to:

- choose an existing plan file
- create a new starter `ticket-plan.jsonc`

The starter plan models:

- `Feature`
- `Story`
- `Task`
- `Bug`

along with workflow statuses, boards, parent-child relationships, and persisted status changes.

### Live Folder Mode

Live Folder mode reads a markdown plans tree directly from disk. Ticket Manager can start from the `plans` folder itself, the `features` folder, or a parent folder and will search for the plans tree automatically.

Expected structure:

- `plans/features/feature-NN-name/feature.md`
- `plans/features/feature-NN-name/story-NN-M-name.md`
- `plans/features/feature-NN-name/task-NN-M-name.md`
- `plans/features/feature-NN-name/bug-NN-M-name.md`

When issue creation is enabled, Ticket Manager follows the same layout:

- Creating a `Feature` creates a new `feature-NN-name/feature.md` folder pair.
- Creating a `Story`, `Task`, or `Bug` requires a parent `Feature` and writes a markdown file inside that feature folder.
- New child issues are also added to the parent feature's `feature.md` item table so later status changes stay in sync.

Use `ticketManager.liveFolderAllowIssueCreation` to disable markdown issue creation and keep Live Folder mode read-only from the extension.

## Boards

Use the `Boards` view to browse available boards, then open a board in the editor area. The board tab groups issues into status columns, supports per-board column configuration, and keeps enabled columns visible even when they are empty.

Board filters are available through:

- `Ticket Manager: Set Board Projects`
- `Ticket Manager: Set Board Types`
- `Ticket Manager: Set Board Search Text`
- `Ticket Manager: Clear Board Filters`

## Settings

- `ticketManager.connectionType`
- `ticketManager.backendMode`
- `ticketManager.planFilePath`
- `ticketManager.liveFolderPath`
- `ticketManager.liveFolderProjectKey`
- `ticketManager.liveFolderProjectName`
- `ticketManager.liveFolderAllowIssueCreation`
- `ticketManager.stdioCommand`
- `ticketManager.stdioArgs`
- `ticketManager.stdioCwd`
- `ticketManager.httpUrl`
- `ticketManager.requestTimeoutMs`
- `ticketManager.defaultPageSize`
- `ticketManager.workspaceMcpServerName`
- `ticketManager.userMcpServerRef`

## Windows Smoke Checklist

1. Run `npm run compile`.
2. Press `F5` to open the Extension Development Host.
3. Run `Ticket Manager: Set Backend Mode` and choose `Jira via MCP`, `Demo`, `File`, or `Live Folder`.
4. Confirm the Activity Bar icon appears and opens the `Tickets` container.
5. If using Jira via MCP mode, run `Ticket Manager: Configure Jira MCP Connection` and then `Ticket Manager: Check Connection`.
6. Verify `My Issues` loads, filters update the list, parent item scoping narrows results, and `Change Status` refreshes the selected issue.
7. Verify `Boards` loads, board filters work, selecting a board opens a tab, and selecting a board issue updates `Issue Details`.
8. If using File mode, confirm a plan file is discovered or created and that changing a status updates the plan file on disk.
9. If using Live Folder mode, confirm the plans folder is detected, existing markdown issues load, and new `Feature`/`Story`/`Task`/`Bug` items create markdown files when `ticketManager.liveFolderAllowIssueCreation` is enabled.

## Packaging

```sh
npx @vscode/vsce package
```

This creates a `.vsix` package that can be installed locally with VS Code's `Install from VSIX...` command.
