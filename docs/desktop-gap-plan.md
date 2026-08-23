# Desktop Gap Closure Plan — UI & AI

Companion to `desktop-feature-parity.md` (the inventory). This document is the
**implementation plan** for the two gap clusters the team is actively closing:
UI-related and AI-related. Jira-specific work is deferred. Audited 2026-08-23.

---

## 1. AI gap — analysis

### Portability verdict: better than expected

The extension's AI subsystem (`vscode-extension/src/ai/`, 6,136 lines) is
**already host-agnostic except for three thin files**:

| File | VS Code coupling | Desktop answer |
|---|---|---|
| `aiSessionManager.ts` (493 lines) | `EventEmitter` ×4, `Memento` (workspaceState) | Tiny typed emitter (~20 lines); memento → existing `jsonKeyValueStore` / `electronHostStorage` |
| `aiProviderSetup.ts` (119) | `showQuickPick`, `commands` | React settings UI (Settings page section) |
| `agentWorkflowCatalog.ts` (426) | `showQuickPick` | React picker dialog |
| **All 18 other files** (~5,200 lines) | **none** — only `node:crypto/fs/path/child_process` + fetch-style HTTP | **Move to `packages/core/src/ai/` verbatim or near-verbatim** |

Other findings that shape the plan:

- **`delegateToCopilot` is not the Copilot LM API** — it forwards to
  `delegateToAiAgent` (the Vercel-gateway runtime). Nothing in the AI stack is
  impossible on desktop; the "Copilot" branding is just a command alias.
- **Agent execution model**: `agentLoop` consumes a `toolExecutor` interface;
  `LocalToolExecutor` runs `fs` read/write + `child_process.exec` behind a shell
  allowlist and path sandbox. Electron main supports all of it unchanged.
- **Gateway client** is plain HTTP to the Vercel AI gateway — host-agnostic.
- **Desktop IPC today has no push channel for streaming events** (only
  `settings:onChanged` and window maximize). Agent sessions stream events
  (tool calls, messages, status) — a generic `ai:onSessionEvent` subscription
  channel is the one genuinely new piece of plumbing.

### What moves where

| Layer | Content | Effort |
|---|---|---|
| `packages/core/src/ai/` | Everything except the 3 coupled files. Add small host seams: `AiSessionStateStore` (memento analog), `AiEventEmitter`, secret lookup via existing `SecretsStore` interface | M |
| Extension adapters | Thin shims so the extension keeps working against core (memento-backed state store, its existing webviews) — replaces its `src/ai/` copies | S |
| Desktop main (`electron-app/src/main/ai/`) | `aiSessionService.ts` (owns runtime instances), `aiIpc.ts` (invoke + event-push channels), wire `AiSessionManager` over `jsonKeyValueStore` | M |
| Preload + `ticketManager.d.ts` | `ai.*` surface: configure provider, list/start/abort sessions, subscribe to session events, list workflow packs, review requests | S |
| Frontend React | Sessions sidebar section, session console view (event stream), gateway settings section, workflow pack picker, "delegate" / "review with AI" actions on issue detail, wire the dormant `NewSession` composer | L |
| Local tools on desktop | `LocalToolExecutor` runs as the desktop user's shell — same trust model as the extension running in the user's VS Code. Keep allowlist + sandbox defaults identical | S |

### AI sub-feature breakdown (for tracking)

| Sub-feature | Backend port | Desktop UI | Notes |
|---|---|---|---|
| Provider setup (Vercel gateway key, model) | ✓ easy (secrets + settings) | Settings page section | Replaces `aiProviderSetup` quick picks |
| Delegate issue to agent | ✓ core move | Issue detail action + picker | |
| Agent sessions: list / view / abort | ✓ core move | Sessions sidebar + console view | Console needs the event-push channel |
| Live session event stream | new IPC channel | console view | The one new plumbing piece |
| Workflow packs (assign to issue) | ✓ core move | picker dialog | |
| AI review (`aiReviewService`, 1,202 lines) | ✓ core move | review panel/page | Largest single file; check its webview ties during the move |
| Issue analysis window | ✓ core logic | React page | |
| Delivery workflow (publish command, artifact pattern) | ✓ core move | settings + run action | Runs user shell commands — same allowlist story |
| Feature decomposition workflow | ✓ core move | action + progress surface | |
| Merge request workflow | ✓ core move | action | GitLab-coupled; fine on desktop |
| New Session composer | n/a | wire existing shell to start-session IPC | Already designed, currently dead |

---

## 2. UI gap — analysis

Three cost tiers, cheapest first. **Tier 1 needs no core/backend changes at all**
— the data and types already exist; only the desktop frontend doesn't render them.

### Tier 1 — render what core already provides (pure frontend)

| Gap | Core support already present | Work |
|---|---|---|
| Sub-tasks in issue detail | `IssueSummary.subTasks[]` | Render list in `IssueDetail.tsx` |
| Linked issues | `IssueDetails.linkedIssues[]` | Render section |
| Attachments list | `IssueDetails.attachments[]` | Render list; download/open needs one dialog/IPC addition |
| Open in browser / copy key | `IssueSummary.browseUrl` | `shell.openExternal` IPC + buttons |
| Paging ("load more") | `PagedIssues.hasMore/total` | `issue:list` IPC gains page params; UI button |
| Issue filters (status/type/assignee/parent scope) | `IssueFilters` in core | Filter bar UI + pass through `issue:list` |
| Create idea / explicit create epic | `CreateIssueInput` covers both | Form variants in `NewIssuePage.tsx` |

### Tier 2 — preferences plumbing exists, UI doesn't

`BoardColumnPreferences` in core already models **every** one of these; the
extension persists them via its memento board-column store. Desktop needs a
per-board prefs store (settings backend or a small JSON store) + IPC + UI.

| Gap | Work |
|---|---|
| List view mode (vs columns) | Prefs store + `BoardView` list renderer |
| Swim lanes (assignee / epic) | Prefs + lane layout in `BoardView` |
| Custom status colors / issue-type colors | Prefs + color pickers + card/column paint |
| Column configuration UI (order, workflow set) | Prefs + config panel (extension's `boardColumnConfigPanel` as reference) |
| Per-column manual issue ordering | Prefs + drag reorder within column |
| Max-age filter | Prefs + filter control |

### Tier 3 — real ports (largest UI chunks)

| Gap | Notes |
|---|---|
| Task Designer | Extension webview is a full canvas app (`taskDesignerPanelManager` + state persistence). Port as a React route; reuse `artifact` of its state model, rewrite rendering. **Largest single UI item.** |
| Local peer review | Webview panel → React page; diff/comment logic is mostly host-agnostic |
| Issue details peek (sidebar) | Desktop sidebar section showing selected issue summary |
| Output/log panel wiring | Bottom panel exists as shell; stream main-process `LogSink` lines over IPC |
| Status/connection indicator | Small title-bar or sidebar element fed by connection check results |

### Explicitly out of scope (deferred with Jira work)

- Import markdown feature plan/files, live-folder→Jira migration, epic/board-query
  linking, Jira artifact archive — migration tooling, ties into the deferred
  Jira track; revisit after the AI port lands.
- New project wizard — extension-only nicety, low daily use.

---

## 3. Phased plan

Order optimizes for user-visible value per unit of risk: pure-frontend wins
first, then prefs plumbing, then the AI foundation (which Phase 4+ UI hangs off),
then the big ports.

| Phase | Content | Size | Depends on |
|---|---|---|---|
| **A. Issue detail depth** | Tier 1 rows: sub-tasks, linked issues, attachments, open-in-browser/copy key | M | — |
| **B. Filters & paging** | Tier 1 rows: issue filter bar, load-more | M | — |
| **C. Board preferences** | Prefs store + IPC, then list view → swim lanes → colors → column config → ordering → max-age | L (sliceable per row) | — |
| **D. AI foundation** | Move `ai/` → core with host seams; extension shims; desktop `aiSessionService` + IPC + event-push channel; provider setup UI | L | — |
| **E. AI sessions UI** | Sessions sidebar, console view, delegate/abort actions, wire `NewSession` composer | M | D |
| **F. AI workflows** | Workflow packs picker, AI review UI, analysis window, delivery workflow, decomposition, MR workflow | L | D, E |
| **G. Creation flows** | Idea + epic form variants | S | — |
| **H. Big ports** | Task Designer, local peer review | XL | D (designer AI hooks) |
| **I. Shell polish** | Sidebar issue peek, log panel wiring, status indicator | S | — |

Each phase ships green: core compiles, frontend `tsc` + vite build, electron-app
compile, full Playwright suite, plus new e2e per phase (mock gateway server for
AI phases, mirroring `mockJiraMcpHttpServer`'s pattern).

### Suggested e2e coverage per phase

- **A**: seeded demo/live-folder issues with sub-tasks/links render and navigate
- **B**: filter narrows a seeded board; load-more fetches page 2
- **C**: set column color/list view → persists across relaunch
- **D–F**: mock Vercel gateway (SSE/wire protocol) asserting delegate → session
  events stream → abort; no live API key needed
- **H**: designer round-trip (create nodes, persist, reopen)

---

## 4. Risks & open questions

1. **AI review file size (1,202 lines)** — likely contains rendering helpers
   entangled with the extension webview; budget a thin split (logic → core,
   rendering → per-host UI) rather than a verbatim move.
2. **Event streaming volume** — agent sessions can be chatty; throttle/coalesce
   `ai:onSessionEvent` payloads rather than forwarding raw.
3. **Shell tool trust model on desktop** — identical to the extension's (user's
   own shell, allowlisted), but the desktop app may feel like a different trust
   boundary to users. Surface the allowlist in Settings before enabling
   delivery-workflow commands by default.
4. **Copilot naming** — drop the "Copilot" alias on desktop or rename to match
   what it actually is (gateway agent); decide when writing the delegate UI.
5. **Extension regression risk during the core move** — the extension must keep
   compiling against moved modules from day one; do the move as
   copy-to-core + shim-first, delete extension copies last.
6. **Budget** — the previous AI-heavy session hit the API spend cap mid-task;
   phases D–F are token-hungry (large file moves + new UI). Plan them as
   separate sessions.
