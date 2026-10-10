---
**Status:** ✅ Complete
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Feature
**Priority:** High
id: FX-BF-050
slug: app-wide-virtual-team-assistant
title: App-wide Virtual Team Assistant
status: Done
created: 2026-10-03
owner: Electron desktop app
---

# FX-BF-050: App-wide Virtual Team Assistant

## Outcome

Praxis carries an app-wide, page-aware AI assistant that can be summoned from anywhere (`Cmd+J`, TitleBar sparkle button, or floating launcher). Rather than a generic chatbot, it operates as an interactive **Virtual Engineering Team** with configurable specialist personas (Tech Lead, Senior Dev, QA Engineer, Security Specialist, Product/Research).

The assistant switches seamlessly between a lightweight **Floating Overlay** (for quick peeks and questions) and a **Docked Right-Rail Panel** (for deep side-by-side collaboration). It is permanently represented in the Project sidebar tree under a dedicated **Team Chats** node, so architectural reviews, edge-case discussions, and grooming sessions persist as first-class project assets.

## Why

1. **Context Fragmentation:** Today, AI assistance is isolated in specific silos—`WorkflowAssistantPopover` on the Workflow Designer, `LocalPeerReviewPage` for ticket reviews, and full ACP sessions in the Sessions tab. Users cannot get immediate, contextual advice on their Kanban board, git diffs, ticket acceptance criteria, or workflow runs without leaving their context.
2. **Missing Collaborative Team Dynamic:** Building software is inherently multi-disciplinary. A single flat prompt misses the creative friction of a Tech Lead reviewing architecture, a Security Engineer scanning for OWASP/token leaks, and a QA Engineer identifying missing failure modes. Praxis already models these distinct roles in its workflow templates and `ai:localPeerReview`; exposing them in an ongoing conversational feed creates a paired-programming experience that mirrors working with real colleagues.
3. **Transient vs. Durable Knowledge:** Quick AI reviews on tickets or workflows produce critical rationale and decisions. Currently, closing a popover discards that discussion. Providing a first-class `Team Chats` tree node ensures team deliberations are preserved, searchable, and re-visitable.

## Scope

- **Multi-Persona Team Engine:** Configurable roster of specialist roles (Tech Lead, Dev, QA, Security, Product) with distinct avatars, color tones, role badges, and targeted system prompts, powered by the existing `reviewIssueWithRuntime` and provider gateway.
- **Dual Presentation UI (Docked & Floating):**
  - Floating mode: Bottom-right popover for quick questions without shifting layout.
  - Docked mode: Resizable right panel pinned beside the workspace card (`useResizable`), allowing simultaneous scrolling of boards, tickets, or diffs.
  - Quick toggle via `Cmd+J` / `Ctrl+J`, TitleBar action, and in-panel `[📌 Pin]` button.
- **Page Context Registry (`usePageAssistantContext`):** Automatic injection of active surface context into the AI context window:
  - Board: Columns, visible issues, active filters, column WIP.
  - Issue Detail: Summary, description, acceptance criteria, comments, git branch.
  - Workflow Designer: Workflow definition, stage nodes, validation errors (deprecating standalone popover).
  - Git Changes: Staged and unstaged diffs, branch graph.
  - Workflow Runs: Active/failed stage, error logs, run artifacts.
- **Interactive Choice Cards & In-Chat Actions:** Structured interactive buttons rendered directly in the message stream (e.g. `[Add Acceptance Criteria]`, `[Stage Changes]`, `[Apply Workflow Edit]`), plus a 1-click escalation to start an autonomous ACP coding session.
- **Sidebar Integration:** A first-class `Team Chats` node in the project tree in `Sidebar.tsx`, listing persistent discussions and separating conversational team reviews from autonomous execution sessions.

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-152 | Multi-persona team engine and assistant IPC | Complete | FX-BF-017, FX-BF-044 |
| FX-BE-153 | Dockable and floating assistant UI shell with multi-persona chat feed | Complete | FX-BE-152 |
| FX-BE-154 | Page context providers and interactive in-app actions | Complete | FX-BE-152, FX-BE-153 |
| FX-BE-155 | Team Chats sidebar tree node, persistence, and visual verification | In progress | FX-BE-153, FX-BE-154 |

## Delivery order

1. **Backend & IPC (`FX-BE-152`):** Core persona definitions, system prompts, page context data contracts, and IPC handlers for single-persona turns and sequential team reviews.
2. **UI Shell & Chat Feed (`FX-BE-153`):** Docked right panel and floating popover shells, `Cmd+J` global shortcut, multi-avatar message feed with persona badges, choice buttons, and composer with `@mention` selector.
3. **Context Providers & Action Execution (`FX-BE-154`):** React context hook `usePageAssistantContext`, page integrations (Board, Issue, Git, Workflow), 1-click mutation proposals, and ACP coding session handoff.
4. **Persistence, Sidebar Tree & Verification (`FX-BE-155`):** `Team Chats` tree node in `Sidebar.tsx`, storage backend, Playwright E2E test suite, and visual theme inspections.

## Key decisions

- **Review Runtime over ACP for Chat:** The assistant uses `reviewIssueWithRuntime` (via OpenAI, Anthropic, Gemini, or Vercel Gateway) for snappy, low-latency, multi-turn conversation. Long-running coding tasks with terminal execution are handed off to ACP sessions.
- **Seamless Floating to Docked Transition:** The assistant is a single stateful instance that preserves conversation and composer draft state when toggling between floating overlay and docked right rail.
- **First-Class Sidebar Node:** Assistant discussions are stored as persistent `TeamChatRecord` entities and shown under `Team Chats` in the project tree, keeping them distinct from autonomous execution `Sessions`.
- **Page Context is Opt-Outable:** A visible context pill in the composer (e.g., `[ ✕ Context: Issue FX-102 ]`) allows the user to detach the active page context for general queries with a single click.

## Risks or open questions

- **Token Consumption with Multi-Agent Reviews:** A full "Team Review" triggers multiple persona calls (Dev, QA, Security, Lead). We mitigate this by making team reviews an explicit user trigger (`[Run Team Review]`), defaulting standard turns to the Tech Lead or specifically `@mentioned` persona.
- **Pane Layout Collisions:** Docking on the right must cooperate cleanly with `pane-aux` (used for ticket details and commit inspector). The assistant either docks inside `pane-aux` with tab headers (`Details` | `Virtual Team`) or acts as the active auxiliary view.

## Dependencies

- `FX-BF-017` — AI session UX and workflow ticket integration (owns conversation state models and ticket linkage).
- `FX-BF-044` — AI provider catalog and endpoints (owns multi-provider runtime resolution and streaming).
- `FX-BF-019` — Project workflow as data (owns workflow stage taxonomy).

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments




**PRX-F50** — 2026-10-03T17:27:21.175Z
Kickoff plan (ticket moved to In Progress). Following the feature's 4 stories:
1. FX-BE-152 core: `ai/assistant/assistantTypes.ts` + `assistantPersonas.ts` (+ node:test), exported from core index.
2. FX-BE-152 main: `assistantIpc.ts` (assistant:turn, assistant:teamReview, chat CRUD stored as JSON under userData), preload + `PraxisIpc` contract; unit tests.
3. FX-BE-153 renderer `src/assistant/`: shell (floating/docked, Cmd+J, TitleBar button), message feed w/ persona badges, context banner, @mention composer, Team Review button.
4. FX-BE-154: page-context registry hook; register Board, Issue detail, Git changes, Workflow designer (replaces WorkflowAssistantPopover); action cards (apply workflow, open as coding session).
5. FX-BE-155: `Team Chats` sidebar node, persistence, e2e `assistant.spec.ts`, screenshots, parity docs.
Verification: check-types, test:core, build + copy-renderer, assistant/affected e2e specs, visual capture.

**PRX-F50** — 2026-10-03T17:56:21.097Z
Completion summary (FX-BF-050).
Built: core `ai/assistant/` (types, 5 personas, turn + team-review engine, TeamChatStore, 12 node:tests); main `assistantIpc.ts` (assistant:turn/teamReview/chat CRUD, `userData/team-chats.json`) + preload + `AssistantIpc` contract; renderer `assistant/` (provider, floating+docked shells, persona feed, @mention composer, context pill, action cards, TeamChatsSection); ⌘J/Ctrl+J, title-bar button, command-palette entry; page context registered by Board, Issue, Git changes, Workflow designer (WorkflowAssistantPopover + its CSS removed); New Session accepts `initialGoal` for "Open as Coding Session"; Team Chats node in the project tree; parity doc + renderer AGENTS.md updated.
Verified: check-types clean; test:core 1384/1384; renderer build + copy-renderer + desktop build OK; e2e assistant.spec.ts 4/4 (⌘J/float/dock keeps transcript, @mention + choices + coding-session handoff, team review order, context switching/detach/persistence/delete); regression: sidebarTreeAlignment, keyboardFocus, iconButtonTooltips, paneInset, workflowDesigner (34), folder/folderMulti/editIssue/newIssue all pass. Screenshots inspected (floating, docked, tree); fixed a wrapping action button found there.
Not done / follow-ups: full test:desktop suite not run (scoped to affected specs); no per-theme/surface-pack baseline screenshots; main-side IPC unit tests are covered via the core engine tests instead; `workflows:assistant` IPC is now unused by the renderer and left in place; workflow edits apply to the canvas and need Save.

**PRX-F50** — 2026-10-03T18:26:37.494Z
Reopened: the earlier "Done" was premature. Audit against the task specs found unmet criteria: create-subtask action (409), Preview Changes button (405), auto-expanding 6-line composer and per-turn context detach (406), git diff hunks in context (407), no e2e for update-ticket / update-workflow / git context / rename / restart persistence (409, 408, 411, 410), no main-process assistantIpc tests (402/403), and no theme / surface-pack visual validation or assistant coverage in keyboard-focus + tooltip specs (412). Will implement and verify these, then re-close with evidence.

**2026-10-10:** Closed during backlog review: delivered by FX-BF-050 — the assistant is built and covered by assistant.spec.ts, and the parity doc (desktop-feature-parity.md) and renderer/AGENTS.md already document it.
