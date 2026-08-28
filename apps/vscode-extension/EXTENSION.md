# Praxis

**A compact issue and board sidebar for VS Code with Jira MCP, demo, and file-backed modes.**

Praxis is a VS Code extension for working with tracked boards, issues, AI sessions, and delivery workflows from a single extension surface. It supports classic multi-view navigation, a board-centric Work Mode, task design and execution planning, AI-assisted review and implementation workflows, and multiple backend types including Jira MCP, Demo, Live Folder, GitLab-oriented delivery flows, and local workspace-backed storage.

## Features

- **Connections & Boards management** for multi-connection setups, with a unified status editor and per-status colours, swim lanes, filters, and per-ticket-type board colours.
- **Two sidebar layouts:** Classic mode (Boards, EPICs, My Issues, Sessions, Issue Details) and Work Mode (board-centric view nesting active AI sessions under boards).
- **Tracked-board browsing** with selection, filtering, and per-board display customisation.
- **Issue workflows** including create, edit, transition, comment, assign-to-me, assign-to-AI, and open-in-browser flows.
- **AI session management** for Copilot, Claude, OpenAI, and CLI-backed agent providers.
- **Local Peer Review (LPR)** for issue-focused review output.
- **Task Designer** for planning execution with ticket nodes, note nodes, website preview nodes, curved connectors, zoom, AI recommendations, and master-plan generation.
- **Jira MCP-backed delivery workflow orchestration**, including worktree-backed delivery flows and sub-task delivery support.
- **Live Folder markdown import/migration helpers** for moving existing planning artefacts into Praxis.

## Requirements

- VS Code `^1.105.0`.
- Optional: a Jira MCP server (`jira-mcp-server` for stdio or `mcp.com.atlassian` for HTTP) configured in `.vscode/mcp.json` or `~/.vscode/mcp.json`.
- Optional: a GitLab project URL and personal access token with API scope for delivery-workflow orchestration.

## Configuration

Open the **Connections & Boards** view (Praxis activity-bar entry → Connections & Boards) and pick the backend type:

- **Jira MCP** — pick the MCP server you configured and add the URL it should connect to; configure tracked boards and optional status overrides.
- **Demo** — file-backed demo data so you can explore the extension without any external service.
- **Live Folder** — point at a folder of markdown ticket files; Tasks and Live-Folder views read from disk.
- **File** — local workspace-backed storage; works offline.
- **GitLab** — focused on delivery flows and merge-request workflows against a project.

Activity bar containers: **Tickets**, **Work Mode**. Switch between Classic and Work Mode layouts from the status-bar menu.

## What's New

### 0.1.0 — Initial store release

- **An issue and board sidebar for VS Code.** A Tickets activity-bar entry plus a board-centric Work Mode that surfaces boards, EPICs, my issues, sessions, and issue details from a single extension surface. Pick a backend (Jira MCP, Demo, Live Folder, File, or GitLab) and that becomes the source of truth for boards, swim lanes, and issue state.
- **Two sidebar layouts.** Classic mode (Boards / EPICs / My Issues / Sessions / Issue Details) and Work Mode (board-centric, with active AI sessions nested under each board).
- **End-to-end issue workflows.** Create, edit, transition, comment, assign-to-me, and assign-to-AI; open in browser; per-status swim lanes; per-ticket-type board colours; board filtering.
- **AI session tracking.** Live provider support for Copilot, Claude, OpenAI, and CLI-backed agents. Sessions appear in the Sessions view and nest under the relevant board in Work Mode.
- **Task Designer.** Plan executions with ticket / note / website-preview nodes, curved connectors, zoom, AI recommendations, and master-plan generation.
- **Jira MCP + GitLab delivery.** Worktree-backed delivery flows and sub-task delivery support driven by a Jira MCP server (`atlassian-jira_*` / `mcp_com_atlassian_*` tools).
- **Local Peer Review (LPR).** Issue-focused review output that runs against the current board context.
- **Store publishing pipeline brought in line with the team.** A dedicated `EXTENSION.md` powers the store detail page; the runtime sidecar JSON is generated at build time from `package.json` + `EXTENSION.md`; build, publish, install-from-gitlab, and CI are all wired so future releases are one command away.

## Known limitations

- GitHub mode is not yet a full issue/board backend with Jira-equivalent parity.
- GitLab support is strongest around delivery/MR workflows and does not mirror Jira behaviour exactly.
- Website preview nodes only show sites that permit embedding.
- Some automation flows depend on correct Jira/GitLab credentials, workflow settings, tracked boards, and repository setup.
