# Praxis Desktop App — Feature Inventory

Legend: **✓** complete · **?** partial / not finished · **✗** missing

Current state of Praxis desktop (Electron) as of 2026-09-15. Core backends ship
to all hosts; desktop-specific features are in the renderer (`apps/praxis-desktop/renderer`)
and Electron integration. Last audited: 2026-09-15.

## Backends & connections

| Feature | Status | Notes |
|---|---|---|---|
| Demo backend | ✓ | Seeded board with starter issues |
| Live folder (markdown plans) | ✓ | Reads `.praxis/` markdown with `board.praxis.json` schema |
| User workspace | ✓ | Persisted project/connection set, versioned `.workspace.praxis.json` files |
| GitLab boards | ✓ | REST API integration via core `GitLabService` |
| Jira via custom MCP server (stdio/HTTP) | ✓ | "Advanced" connection mode; see `packages/core/src/mcp/` |
| Jira Cloud OAuth sign-in (browser) | ✓ | `praxis://` scheme + loopback fallback for app-initiated OAuth |
| Jira Cloud API-token sign-in (guided) | ✓ | Guided form in Connections UI; stores encrypted PAT |
| GitHub boards | ✓ | REST API client (`GitHubBoardService`); one board per repository, columns synthesized from "status: …" labels already on the repo (FX-BE-035) |
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
| Saved Praxis workspace contexts | ✓ | `.workspace.praxis.json` files; Getting Started offers recent workspaces |
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
| Global quick-pick search | ✓ | Palette (⌘K) searches issues across every board in the active workspace via debounced async lookup, capped at 25 results (FX-BE-037) |
| Open issue in browser / copy key | ✓ | Buttons in detail header + right-click context menu |
| Create idea | ✓ | "Idea" is a selectable issue type in the create form (`NewIssuePage.tsx`/`IssueDetail.tsx`) |
| Create epic | ✓ | Create issue with `parent: epic` or implicit new parent |
| Issue details peek (sidebar) | ✓ | `IssuePeek.tsx`, pinned above the sidebar footer when an issue is selected |

## AI & agents

| Feature | Status | Notes |
|---|---|---|
| AI provider setup (Vercel gateway) | ✓ | Settings → AI Provider; stores encrypted API key in `safeStorage` |
| Provider catalog + OpenAI-compatible endpoints | ✓ | Settings → AI Provider lists providers in use; **Add provider** picks a built-in, a preset (OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Fireworks, Cerebras, Ollama, LM Studio, vLLM, llama.cpp) or a custom endpoint. Each endpoint is tested (models / chat / streaming usage / tool calling) before save; one without tool calling is kept out of sessions and workflows but still serves recommendations (FX-BF-044) |
| App-wide Virtual Team Assistant | ✓ | `⌘J` / `Ctrl+J`, the title-bar sparkle button or the floating launcher. Five personas (Tech Lead, Senior Dev, QA, Security, Product) answer on the provider's review runtime (`assistant:turn`); `@qa`-style mentions pick the persona, **Team Review** runs Dev → QA → Security → Lead. One conversation moves between a floating popover and a docked, resizable right column (pin button). Pages advertise context through `useRegisterPageAssistantContext` — Board, Issue, Git changes, Workflow designer (replaced the old designer popover) — shown as a detachable context pill. Replies may carry choice chips and an action card with **Preview Changes** (update the ticket description, create a subtask under its feature, apply a workflow edit, or hand the plan to a new coding session). Git context includes the staged/unstaged diff hunks; detaching the context pill lasts one message; the composer grows to six lines. Chats persist under **Team Chats** in each project's tree (`userData/team-chats.json`); rename by double-click, delete on hover. Chat-only: it cannot run commands or edit files itself (FX-BF-050) |
| Delegate issue to AI agent | ✓ | Issue detail action; picker selects agent + assigns workflow pack; full ticket context (summary, description, parent feature, sibling tasks, dependencies, linked issues, comments, transitions) automatically injected into system prompt and tracker tools exposed via loopback MCP server (`praxis-tracker`) and Gateway tools |
| Agent selection | ✓ | Agent Hub browser; runs system runtime or CLI executable |
| Assign workflow pack | ✓ | Dropdown in delegate picker; attaches pack to session |
| Active sessions view + view/abort session | ✓ | Sessions sidebar section; console shows live event stream |
| Session purpose in the inspector | ✓ | Summary tab shows the ticket/plan goal, scope and definition of done (FX-BE-115) |
| Living handover brief | ✓ | Auto-refreshes after each completed turn; user-editable notes survive refresh (FX-BE-115) |
| Change model during a session | ✓ | Composer action; blocked while a turn is running; records a runtime epoch (FX-BE-115) |
| Hand over to another AI | ✓ | Same Praxis session and worktree; receiving AI gets a redacted brief and is asked to inspect files (FX-BE-115) |
| Multi-AI conversation in one session | ✓ | Opt-in Bring in another AI (consult / debate / pair); attributed assistant speakers, sequential tool ownership and capped turns; not default handover (FX-BE-122) |
| Handover context snapshot | ✓ | Every handover carries a bounded, versioned snapshot (commit, files handed over and left out with reasons, ticket dependencies); a malformed or stale handover is blocked with the reason (FX-BE-092) |
| Session coordination | ✓ (macOS) | One local broker per OS user: gateway writes and commands are enforced; ACP hosted writes, the in-app browser and the coordination tools are cooperative. Agents wait (bounded) for what another session holds and are woken on release; services a command leaves running stay claimed with their ports until they exit or are stopped from the inspector; a person using the in-app browser takes it from an agent; a write after the branch moved underneath is refused once. Opt-in hooks proven live for Claude Code and Codex; Copilot and Gemini adapters unproven live. Linux/Windows verification deferred (TASK-438; [capability matrix](research/coordination-capability-matrix.md)) |
| Out-of-scope changes at merge | ✓ | A merge stage's `declaredPaths` + `outOfScope: block \| escalate` hold back or flag undeclared changes (FX-BE-094) |
| AI review of issue | ✓ | Issue detail action; review panel streams markdown |
| Issue analysis window | ✓ | Issue detail action; runs analysis workflow + shows results inline |
| Delivery workflow (publish command / artifact pattern) | ✓ | Workflow stages with delivery gates; publishes artifacts to Claude.ai |
| Feature decomposition workflow | ✓ | Workflow action; generates subtasks from issue |
| Merge request workflow | ✓ | Workflow action; GitLab-specific; creates/updates MRs |
| Agent loop with local tools (shell allowlist, path sandbox) | ✓ | `LocalToolExecutor` runs user shell commands behind allowlist |
| Live session event stream | ✓ | Console shows agent messages, tool calls, reasoning (ACP protocol) |
| Cost tracking per session | ✓ | Shows cumulative cost if provider reports it; warning at `ai.spendLimit` |
| Cost/token reporting over time | ✓ | Settings → AI Provider spend report; grouped by provider/model and connection, time-range filter (FX-BE-039) |
| AI usage on the Overview dashboard | ✓ | Full-width panel: today / week / month / all-time tokens, cost and peak, plus ranked top models (FX-BF-049). Reads the durable usage ledger, and Settings → AI Usage shows the same model breakdown. Cost is "Not reported" for providers that do not report it (only ACP agents do), never `$0.00`. The total deliberately differs from Settings → AI → Spend, which reads `AgentSessionRecord`s and excludes internal one-shot AI calls; "all time" is bounded by the 20,000-event ledger cap and labelled `since <first event>` |
| Agent's own operating mode (ACP Session Modes) | ✓ | Composer mode chip, live while the task is active — distinct from Praxis's own chat/analysis/review toggle (FX-BE-038) |
| Agent's own slash commands (ACP `available_commands_update`) | ✓ | Composer commands chip inserts `/name ` into the draft (FX-BE-038) |
| Workflow run started from a ticket, outcome written back | ✓ | Run monitor's Start form takes an optional ticket; a settled run posts a comment back to it (FX-BE-040) |
| Workflow fix loops and findings routing | ✓ | Connections can route on a stage's findings; a back-edge is a bounded loop that reopens its target with the findings; a spent budget waits for a person (accept / one more pass / stop). Governed delivery loops review and security findings back to Implement (FX-BF-108) |
| Independent reviewers and skeptic stages | ✓ | `independentOf` runs a stage on a different AI or model from its author and says when it could not; a skeptic stage refutes findings before they gate or loop (FX-BF-108) |
| For each (map) workflow stages | ✓ | Fan an agent out over a run-time list of findings or plan items, each writing item in its own worktree, merged back in order (FX-BF-108) |
| Improve until target template | ✓ | Goal, target or rubric, and iteration count at start; keep-best loop with patience; tests guarded against weakening; ends on the best pass (FX-BF-108) |
| Run parameters and worst-case cost at start | ✓ | Start dialog asks for a workflow's parameters and shows the worst-case agent sessions, with a confirm above a configurable threshold (FX-BF-108) |

## Developer workflow

| Feature | Status | Notes |
|---|---|---|
| Task Designer | ✓ | Canvas app; drag nodes, wire logic, save to `.praxis/tasks/` |
| Local peer review panel | ✓ | Right pane; markdown-rendered review with comment threads |
| Git worktree management | ✓ | Workflow orchestrator creates run-specific worktrees; cleanup on completion |
| Create branch from issue | ✓ | Git graph context menu; launches branch-naming dialog |
| Git graph | ✓ | Full commit history view; interactive branch/tag/rebase; conflict resolution UI |
| Diff workspace | ✓ | Structured change view per commit; hunk-level staging; WIP tracking |
| Failure diagnosis from retained evidence | ~ | Core-only (FX-BE-051/052): evidence capture, redaction, bounded repair attempts and a "Diagnose" action in the run monitor. No Electron e2e verification yet — see the task completion evidence under `apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/`. |
| CI evidence import (GitHub Actions / GitLab CI) | ~ | Core-only (FX-BE-053): read-only providers, log import into the evidence store, commit-availability preflight before diagnosing. **Credential scope: `actions:read`/`contents:read` for a GitHub token, `read_api` for a GitLab token — read-only; nothing here dispatches, cancels, or re-runs a job.** No connection/picker UI yet — see the task completion evidence for what remains. |
| Deployment profiles (executor/target selection, credentials, review) | ~ | FX-BE-059/060: profile CRUD (main IPC + renderer editor), executor and target as independent selectors, credential name/bound-status editing. No Electron e2e verification yet. |
| Direct-process executor — `local-process` target | ~ | Spawns a configured, reviewed script with typed inputs passed as environment variables (no shell interpolation); bounded output, timeout, cancellation. Core-verified (`packages/core/src/deployments`); no Electron e2e. |
| Direct-process executor — `directory` target | ~ | Stages, backs up, and replaces a persistent web root; post-install health check with an explicit (never automatic) rollback action. Core-verified; no Electron e2e. |
| Deployment promotion (shared artifact digest, environment-scoped approval) | ~ | The same published artifact redeployed to a different profile gets a fresh, independently-scoped approval and health evidence — proven end to end at the core level (`directDeliveryJourney.test.ts`); renderer "promote" action exists, no Electron e2e. |
| Pipeline-managed deployment executors (GitHub Actions / GitLab CI) | ✗ | Schema-valid profile fields only (`DeploymentProfile.executor`); execution deferred to FX-BF-024. |
| IIS deployment target | ✗ | Schema-valid target fields only (`DeploymentProfile.target`); Windows-only, deferred to FX-BF-025. |

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
| Status/connection indicator | ✓ | `ConnectionStatusDot.tsx` on each non-demo sidebar connection group, fed by `connection.check` |
| Output / log panel | ✓ | Bottom panel with Output (terminal) tab; Application tab planned |
| Application logs | ✓ | Output tab tails the shared log bus (`[ai]`, `[jira]`, `[gitlab]`, `[workflow]` tags); 500-line ring buffer, no search/export/persistence across restarts (FX-BE-041) |
| Native window chrome | ✓ | Electron default frame; settings option to hide |
| Auto-update | ✓ | Signed, notarized builds (FX-BE-034; blocked on credentials) |
| Installer packaging | ✓ | DMG (Mac), MSI (Windows), AppImage (Linux) |

## Remaining gaps

Largest unfinished items, ordered by adoption impact:

1. **Signed builds & auto-update** (FX-BE-034) — "try Praxis" currently means "maintain a local build." Blocked on code-signing credentials.
2. **Multi-file / terminal agent proof** (FX-BE-036) — the ticket-to-agent flow is scripted-proven only for single-file, no-shell edits.
3. **Application logs — search/export/persistence** — Output tab tails the log bus live (FX-BE-041); still a 500-line in-memory ring buffer with no history across restarts.

**Shipped since the last audit: GitHub real backend** (FX-BE-035) — `GitHubBoardService`
in core, wired through `serviceRegistry.ts`'s `case 'github'`. One repository is one
board (`autoSynthesizesBoard`, same model as folder/demo); columns synthesize from
"status: …" labels already on the repo, with Backlog/Closed always present so a
repo with none still renders a working board. Edits cover summary, description,
and assignee — the same three fields GitLab supports, since GitHub's issue API
has no native priority/severity/type. Issue creation is gated behind an
`allowIssueCreation` connection setting, mirroring folder's gate. No new theme
token or renderer component: `--tone-github` and `BACKEND_MODE_META.github`
already existed.

Corrected in this pass (previously listed here as ✗ without independent
verification — all three already exist and are e2e-tested):
create idea, issue details peek in sidebar, connection status indicator.

Also corrected: **GitHub boards** was marked ✓ ("REST API client, in active
development") when it was not implemented at all — the mode had no `case` in
`serviceRegistry.ts` and resolved to `StubBackendService`. Marked ✗, then
shipped as FX-BE-035 in this pass (see below) and marked ✓ again — this time
against real code and a passing e2e suite, not a forward-looking claim.

Closed since the previous audit (FX-BF-017, 2026-09-05): command palette issue
index, ACP available-commands/current-mode surfacing, the AI spend report,
workflow ticket-triggering with outcome write-back, and workflow failures
wired into the Output tab's log bus. See `PLAN_MAP.md`.
