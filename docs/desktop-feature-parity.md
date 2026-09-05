# Praxis Desktop App — Feature Inventory

Legend: **✓** complete · **?** partial / not finished · **✗** missing

Current state of Praxis desktop (Electron) as of 2026-09-05. Core backends ship
to all hosts; desktop-specific features are in the renderer (`apps/praxis-desktop/renderer`)
and Electron integration. Last audited: 2026-09-05.

## Backends & connections

| Feature | Status | Notes |
|---|---|---|---|
| Demo backend | ✓ | Seeded board with starter issues |
| Live folder (markdown plans) | ✓ | Reads `.praxis/` markdown with `board.praxis.json` schema |
| User workspace | ✓ | Persisted project/connection set, versioned `.workspace.praxis` files |
| GitLab boards | ✓ | REST API integration via core `GitLabService` |
| Jira via custom MCP server (stdio/HTTP) | ✓ | "Advanced" connection mode; see `packages/core/src/mcp/` |
| Jira Cloud OAuth sign-in (browser) | ✓ | `praxis://` scheme + loopback fallback for app-initiated OAuth |
| Jira Cloud API-token sign-in (guided) | ✓ | Guided form in Connections UI; stores encrypted PAT |
| GitHub boards | ✓ | REST API client (FX-BE-035, in active development) |
| Connections manager UI | ✓ | Sidebar + detail pane; add/remove/test connections |
| Connection health check | ✓ | Test button; reports auth/network status inline |
| Encrypted secret storage | ✓ | Electron `safeStorage` API; autolock on suspend |
| Multi-connection board merge | ✓ | Virtual board fuses multiple connections' issues |

## Boards

| Feature | Status | Notes |
|---|---|---|
| Kanban board view | ✓ | Columns per workflow status; cards show summary + priority/assignee chips |
| Drag-drop status transitions | ✓ | Moves issues between columns; logs to session transcript if agent-delegated |
| Empty workflow columns stay visible | ✓ | All statuses shown; no issues ≠ column hidden |
| Board list / sidebar navigation | ✓ | Project-owned boards + tracked cross-connection boards |
| Board filters (project / type / search text) | ✓ | Sidebar filter bar; narrows board view |
| Tracked boards (pin across connections) | ✓ | Add boards to the fixed sidebar set across different backends |
| Create board wizard | ✓ | Guided flow; saves to user workspace |
| List view mode (vs columns) | ✓ | Toggle in Board Settings; renders issues as a sortable list |
| Swim lanes (assignee / epic) | ✓ | Board Settings: none / assignee / epic; groups cards within columns |
| Custom per-status column colors | ✓ | Color picker in Board Settings per workflow status |
| Custom per-issue-type colors | ✓ | Color picker in Board Settings per issue type |
| Board column configuration UI (order, workflow set) | ✓ | Drag reorder in Board Settings; toggle which statuses appear |
| Per-column manual issue ordering | ✓ | Drag issues within a column; persists to board prefs |
| Max-age filter (hide stale issues) | ✓ | Board Settings: days since last update threshold |
| New project wizard | ✓ | Guided flow for Demo / Folder / Jira / GitLab / GitHub projects |
| Saved Praxis workspace contexts | ✓ | `.workspace.praxis` files; Getting Started offers recent workspaces |
| Project-first sidebar hierarchy | ✓ | Sidebar tree: projects own boards and Git; unlinked boards stay discoverable |
| Project-details inspector (right pane) | ✓ | Status summary, completion tracker, workspace tags, planning-source switcher (FX-BF-008) |
| Remove / delete board from the sidebar list | ✓ | Context menu; routes per backend (user-workspace, live-folder, tracked-board) |
| Per-board plain background (disable surface material) | ✓ | Board Settings → Appearance toggle; disables surface pattern/grain |
| No-boards centre state with Create board action | ✓ | Empty project guides to Connections; no fallback to session composer |

## Issues

| Feature | Status | Notes |
|---|---|---|
| Issue detail view | ✓ | Full right pane; summary, description, comments, fields, related issues |
| Edit fields (summary, description, assignee, priority, severity, type) | ✓ | Inline editing where backend supports it |
| Comments (view + add) | ✓ | Thread per issue; markdown rendering |
| Workflow transitions from detail view | ✓ | Status dropdown; no custom transition UI |
| Create issue | ✓ | Dialog or inline in board; supports implicit parent |
| Issue-level filters | ✓ | Sidebar filter bar: status, type, assignee, board scope |
| Sub-tasks (view + create) | ✓ | Render list in detail pane; create dialog |
| Linked issues | ✓ | Render "Linked issues" section; navigate to linked issue |
| Attachments | ✓ | Render list; download via IPC dialog |
| Paging ("load more") | ✓ | Load-more button when `hasMore` set; fetches next page per status |
| Global quick-pick search | ✗ | Palette has board/project/session search only; no global issue search |
| Open issue in browser / copy key | ✓ | Buttons in detail header + right-click context menu |
| Create idea | ✗ | Issue creation UI exists; "idea" type is Jira-specific mapping, not exposed |
| Create epic | ✓ | Create issue with `parent: epic` or implicit new parent |
| Issue details peek (sidebar) | ✗ | No compact issue summary in sidebar; use detail pane instead |

## AI & agents

| Feature | Status | Notes |
|---|---|---|
| AI provider setup (Vercel gateway) | ✓ | Settings → AI Provider; stores encrypted API key in `safeStorage` |
| Delegate issue to AI agent | ✓ | Issue detail action; picker selects agent + assigns workflow pack |
| Agent selection | ✓ | Agent Hub browser; runs system runtime or CLI executable |
| Assign workflow pack | ✓ | Dropdown in delegate picker; attaches pack to session |
| Active sessions view + view/abort session | ✓ | Sessions sidebar section; console shows live event stream |
| AI review of issue | ✓ | Issue detail action; review panel streams markdown |
| Issue analysis window | ✓ | Issue detail action; runs analysis workflow + shows results inline |
| Delivery workflow (publish command / artifact pattern) | ✓ | Workflow stages with delivery gates; publishes artifacts to Claude.ai |
| Feature decomposition workflow | ✓ | Workflow action; generates subtasks from issue |
| Merge request workflow | ✓ | Workflow action; GitLab-specific; creates/updates MRs |
| Agent loop with local tools (shell allowlist, path sandbox) | ✓ | `LocalToolExecutor` runs user shell commands behind allowlist |
| Live session event stream | ✓ | Console shows agent messages, tool calls, reasoning (ACP protocol) |
| Cost tracking per session | ✓ | Shows cumulative cost if provider reports it; warning at `ai.spendLimit` |

## Developer workflow

| Feature | Status | Notes |
|---|---|---|
| Task Designer | ✓ | Canvas app; drag nodes, wire logic, save to `.praxis/tasks/` |
| Local peer review panel | ✓ | Right pane; markdown-rendered review with comment threads |
| Git worktree management | ✓ | Workflow orchestrator creates run-specific worktrees; cleanup on completion |
| Create branch from issue | ✓ | Git graph context menu; launches branch-naming dialog |
| Git graph | ✓ | Full commit history view; interactive branch/tag/rebase; conflict resolution UI |
| Diff workspace | ✓ | Structured change view per commit; hunk-level staging; WIP tracking |

## Import / migration

| Feature | Status | Notes |
|---|---|---|
| Import markdown feature plan | ✗ | Deferred; planned after AI/GitHub backend land |
| Import markdown files | ✗ | Deferred; planned after AI/GitHub backend land |
| Migrate live folder → Jira MCP | ✗ | Deferred; couples to Jira work; planned as a separate track |
| Link Jira epic / board query to a folder | ✗ | Deferred; requires live-folder multi-root semantics |
| Jira artifact archive | ✗ | Deferred; Jira-specific; low priority |

## Settings & shell

| Feature | Status | Notes |
|---|---|---|
| Settings UI (appearance, behaviour) | ✓ | In-app Settings page (no VS Code coupling) |
| Workspace-first startup and restore | ✓ | Getting Started; restore flow; recent workspaces picker |
| Theme switching | ✓ | Settings → Appearance; active theme, 6+ built-in palettes + surface packs |
| Theme-aware right-pane surfaces | ✓ | All panes inherit active theme; no opacity/fallback |
| Status/connection indicator | ✗ | No title-bar or sidebar health indicator; connection state visible in Connections UI only |
| Output / log panel | ✓ | Bottom panel with Output (terminal) tab; Application tab planned |
| Application logs | ✗ | Agent session failures / workflow errors visible in console only; no persistent log viewer |
| Native window chrome | ✓ | Electron default frame; settings option to hide |
| Auto-update | ✓ | Signed, notarized builds (FX-BE-034; blocked on credentials) |
| Installer packaging | ✓ | DMG (Mac), MSI (Windows), AppImage (Linux) |

## Remaining gaps

Largest unfinished items, ordered by adoption impact:

1. **GitHub real backend** (FX-BE-035) — currently GitHub connections save metadata only. Real board requires REST client + issue list → board mapping.
2. **Signed builds & auto-update** (FX-BE-034) — "try Praxis" currently means "maintain a local build." Blocked on code-signing credentials.
3. **Command palette issue index** — ⌘K indexes projects/boards/sessions/agents but not issues. High-value daily quality-of-life gap.
4. **Available slash commands from agent** (ACP `available_commands_update`) — Unhandled protocol update. Users can't discover agent's own ⌘ commands.
5. **Workflow write-back to issue** — Runs complete, but outcome (status transition, comment, artifact link) doesn't write back to the source ticket.
6. **Global issue search** — Palette has board/project search; no global quick-pick across all connections.
7. **Cost attribution over time** — Per-session cost visible; no project/team-level spend report or historical view.
8. **Idea creation** — Jira-specific; currently no first-class UI for it.
9. **Issue details peek in sidebar** — Compact issue summary in sidebar instead of full detail pane.
