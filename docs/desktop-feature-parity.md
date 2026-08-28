# Feature Parity Plan — VS Code Extension vs Desktop App

Legend: **✓** complete · **?** partial / not finished · **✗** missing

Scope notes: the desktop app (Electron) reuses `packages/core` backends and the
shared `apps/praxis-desktop/renderer` React UI; the extension uses its own webview panels and
tree views. Backend *engines* are near-identical — the gaps are almost all in UI
surface and host integrations. Last audited: 2026-08-23.

## Backends & connections

| Feature | Extension | Desktop | Notes |
|---|---|---|---|
| Demo backend | ✓ | ✓ | |
| Live folder (markdown plans) | ✓ | ✓ | |
| User workspace | ✓ | ✓ | |
| GitLab boards | ✓ | ✓ | |
| Jira via custom MCP server (stdio/HTTP, "Advanced") | ✓ | ✓ | |
| Jira Cloud OAuth sign-in (browser) | ✓ | ✓ | Extension: `vscode://` redirect. Desktop: `praxis://` scheme + loopback fallback |
| Jira Cloud API-token sign-in (guided) | ? | ✓ | Extension: only via manual Advanced HTTP header config |
| Bring-your-own 3LO OAuth client (org-restricted tenants) | ✗ | ✓ | Desktop-only: pre-registered client id/secret, direct `auth.atlassian.com` flow |
| Connections manager UI | ✓ | ✓ | |
| Connection health check | ✓ | ✓ | |
| Encrypted secret storage | ✓ | ✓ | VS Code SecretStorage / Electron safeStorage |
| Multi-connection board merge | ✓ | ✓ | |

## Boards

| Feature | Extension | Desktop | Notes |
|---|---|---|---|
| Kanban board view | ✓ | ✓ | |
| Drag-drop status transitions | ✓ | ✓ | |
| Empty workflow columns stay visible | ✓ | ✓ | |
| Board list / sidebar navigation | ✓ | ✓ | |
| Board filters (project / type / search text) | ✓ | ✓ | |
| Tracked boards (pin across connections) | ✓ | ✓ | |
| Create board wizard | ✓ | ✓ | |
| List view mode (vs columns) | ✓ | ✗ | `viewMode: 'board' \| 'list'` |
| Swim lanes (assignee / epic) | ✓ | ✗ | |
| Custom per-status column colors | ✓ | ✗ | Desktop has fixed status tones only |
| Custom per-issue-type colors | ✓ | ✗ | |
| Board column configuration UI (order, workflow set) | ✓ | ✗ | |
| Per-column manual issue ordering | ✓ | ✗ | |
| Max-age filter (hide stale issues) | ✓ | ✗ | |
| New project wizard | ✓ | ✗ | |

## Issues

| Feature | Extension | Desktop | Notes |
|---|---|---|---|
| Issue detail view | ✓ | ✓ | |
| Edit fields (summary, description, assignee, priority, severity, type) | ✓ | ✓ | |
| Comments (view + add) | ✓ | ✓ | |
| Workflow transitions from detail view | ✓ | ✓ | |
| Create issue | ✓ | ✓ | Desktop supports implicit new parent (`newParentSummary`) |
| Issue-level filters (status, type, assignee me/all, parent scope) | ✓ | ? | Desktop sidebar has a subset; no parent-scope or grouping control |
| Sub-tasks (view + create) | ✓ | ✗ | |
| Linked issues | ✓ | ✗ | |
| Attachments | ✓ | ✗ | |
| Paging ("load more") | ✓ | ✗ | Desktop loads first page only |
| Global quick-pick search (issues / epics / boards) | ✓ | ✗ | Desktop has board-list text filter only |
| Open issue in browser / copy key | ✓ | ✗ | |
| Create idea | ✓ | ✗ | |
| Create epic | ✓ | ? | Desktop: only implicitly via new-parent on create |
| Issue details peek (sidebar) | ✓ | ✗ | Extension sidebar view |

## AI & agents

| Feature | Extension | Desktop | Notes |
|---|---|---|---|
| AI provider setup (Vercel gateway) | ✓ | ✗ | |
| Delegate issue to AI agent | ✓ | ✗ | |
| Delegate to Copilot | ✓ | ✗ | |
| Assign workflow pack | ✓ | ✗ | |
| Active sessions view + view/abort session | ✓ | ✗ | |
| AI review of issue (`reviewWithAi`) | ✓ | ✗ | |
| Issue analysis window | ✓ | ✗ | |
| Delivery workflow (publish command / artifact pattern) | ✓ | ✗ | |
| Feature decomposition workflow | ✓ | ✗ | |
| Merge request workflow | ✓ | ✗ | |
| Agent loop with local tools (shell allowlist, path sandbox) | ✓ | ✗ | |
| Agent session composer | ✓ | ? | Desktop `NewSession` view is a UI shell — not wired to any agent runtime |

## Developer workflow

| Feature | Extension | Desktop | Notes |
|---|---|---|---|
| Task Designer | ✓ | ✗ | |
| Local peer review panel | ✓ | ✗ | |
| Git worktree management | ✓ | ✗ | |
| Create branch from issue | ✓ | ✗ | |

## Import / migration

| Feature | Extension | Desktop | Notes |
|---|---|---|---|
| Import markdown feature plan | ✓ | ✗ | |
| Import markdown files | ✓ | ✗ | |
| Migrate live folder → Jira MCP | ✓ | ✗ | |
| Link Jira epic / board query to a folder | ✓ | ✗ | |
| Jira artifact archive | ✓ | ✗ | |

## Settings & shell

| Feature | Extension | Desktop | Notes |
|---|---|---|---|
| Settings UI (appearance, behaviour) | ✓ | ✓ | VS Code settings vs in-app Settings page |
| Theme switching | ✓ | ✓ | Extension follows VS Code theme; desktop has its own switcher |
| Status bar (connection state) | ✓ | ✗ | |
| Output / log panel | ✓ | ? | Desktop bottom panel has Output/Terminal tabs — shell only |
| Native window chrome (title bar, min/max/close) | n/a | ✓ | |
| MSI installer packaging | n/a | ✓ | |

## Parity gap — suggested completion order

1. **Issue detail depth** — sub-tasks, linked issues, attachments, open-in-browser / copy key. Highest daily-use value; backend calls already exist in core.
2. **Issue filtering & paging** — status/type/assignee/parent-scope filters and "load more". Board filters exist; issue filters are the gap.
3. **Board customization** — list view, swim lanes, column config UI, status/type colors. Core `BoardColumnPreferences` already models all of it; desktop UI doesn't expose it.
4. **Creation flows** — create idea, explicit create epic.
5. **AI & agent stack** — the largest block: provider setup, delegation, sessions, review, delivery workflows. Needs an IPC layer plus porting `ai/` from the extension into core.
6. **Developer workflow** — Task Designer, local peer review, worktrees, branch-from-issue.
7. **Import / migration tooling** — markdown import, live-folder→Jira migration, epic/board-query linking.
8. **Shell polish** — status/connection indicator, wire the Output tab to real logs.
