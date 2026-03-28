# Jira Mini

Jira Mini is a desktop VS Code extension that adds a focused Jira experience to the Activity Bar. It now routes all ticket interactions through an injectable backend service, so the UI can run against Jira MCP today and a built-in demo backend without any external service.

## Features

- Activity Bar view container for Jira workflows
- My Issues tree with filters for projects, statuses, issue types, text, and assignee scope
- Boards tree with filters for projects, board types, and search text
- Board editor tab that groups board issues into Jira-style status columns
- Epic scoping with resilient Jira Cloud query fallbacks
- Issue details view with transitions and browser/open-copy actions
- Injectable backend service layer so the UI no longer depends directly on Jira
- Demo mode with built-in sample projects, issues, boards, and transitions
- Diagnostics for missing MCP configuration, missing capabilities, and empty access

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

The integration suite launches the extension in an Extension Development Host and talks to a fake Jira MCP server over stdio. It verifies:

- extension activation and command registration
- project and issue loading
- board loading, board filters, and board panel rendering
- demo mode without any configured Jira backend
- empty access diagnostics
- epic scoping
- successful and rejected transitions
- capability validation

## Backend modes

Jira Mini supports two runtime modes:

- `jira`: use a Jira MCP backend
- `demo`: use built-in demo data with no backend required

Switch between them with:

- `Jira Mini: Set Backend Mode`
- `jiraMini.backendMode`

When Jira mode is active, configure either:

- a local `stdio` server
- a remote `http` MCP server

Jira Mini can also reuse Jira MCP servers from existing editor config in this order when no manual Jira Mini connection is configured:

- workspace `.vscode/mcp.json`
- VS Code user config at `%APPDATA%\Code\User\mcp.json`
- VS Code profile configs under `%APPDATA%\Code\User\profiles\*\mcp.json`
- VS Code Insiders user config at `%APPDATA%\Code - Insiders\User\mcp.json`
- VS Code Insiders profile configs under `%APPDATA%\Code - Insiders\User\profiles\*\mcp.json`
- Cursor global config at `~/.cursor/mcp.json`

Use one of these commands after launch:

- `Jira Mini: Configure Connection`
- `Jira Mini: Set Backend Mode`
- `Jira Mini: Use Workspace MCP Configuration`
- `Jira Mini: Use User/Profile MCP Configuration`

If Jira Mini finds exactly one Jira-like server in the workspace or user/profile MCP config, it will usually pick it up automatically without extra setup.

### Boards

Use the `Boards` view to browse accessible Jira boards, then select a board to open a board tab in the editor area. The board tab groups issues into status columns using the statuses currently present on that board and clicking an issue card syncs the `Issue Details` view.

Board filters are available through:

- `Jira Mini: Set Board Projects`
- `Jira Mini: Set Board Types`
- `Jira Mini: Set Board Search Text`
- `Jira Mini: Clear Board Filters`

### Settings

- `jiraMini.connectionType`
- `jiraMini.backendMode`
- `jiraMini.stdioCommand`
- `jiraMini.stdioArgs`
- `jiraMini.stdioCwd`
- `jiraMini.httpUrl`
- `jiraMini.requestTimeoutMs`
- `jiraMini.defaultPageSize`
- `jiraMini.workspaceMcpServerName`
- `jiraMini.userMcpServerRef`

## Windows Smoke Checklist

1. Run `npm run compile`.
2. Press `F5` to open the Extension Development Host.
3. Run `Jira Mini: Set Backend Mode` and choose either `Demo Mode` or `Jira MCP`.
4. Confirm the Activity Bar icon appears and opens the `Jira` container.
5. If using Jira MCP, run `Jira Mini: Configure Connection` and then `Jira Mini: Check Jira Connection`.
6. Verify `My Issues` loads, filters update the list, epic scoping narrows results, and `Change Status` refreshes the selected issue.
7. Verify `Boards` loads, board filters work, selecting a board opens a tab, and selecting a board issue updates `Issue Details`.

## Packaging

```sh
npx @vscode/vsce package
```

This creates a `.vsix` package that can be installed locally with VS Code's `Install from VSIX...` command.
