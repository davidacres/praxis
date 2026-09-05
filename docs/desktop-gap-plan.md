# Desktop Gaps — Remaining Work

Progress on closing desktop/core feature parity. As of 2026-09-05, most "big gaps"
have shipped (FX-BF-009 through FX-BF-014). This doc tracks what's left.

**Previously on this list (now complete):**
- Phase A–F (Issue detail depth, board prefs, filters, AI foundation, sessions UI, workflows) — shipped in FX-BF-009–BF-014.
- Phase H (Task Designer) — shipped in FX-BF-010, polished in FX-BE-023.
- Phase I shell polish (output wiring, status indicator) — partially shipped; see below.

**Actively open: FX-BF-016** (signed builds, GitHub backend, agent proof-of-concept)

**Also complete since: FX-BF-017** (AI session UX and workflow ticket
integration) — command palette issue search, ACP session modes/slash commands,
the AI spend report, ticket-triggered workflow runs with write-back, and
workflow failures wired into the Output tab's log bus.

---

## What shipped (reference only)

FX-BF-009 through FX-BF-015 completed the AI, board customization, and workflow
orchestration stacks. The renderer now carries `ai/`, `workflows/`, `agents/`,
and `board/` features that were initially spec'd as "gaps." Core abstracted
host-agnostic agent logic; desktop wired it via IPC.

---

## What remains

### 1. FX-BF-016 — Current blockers

#### FX-BE-034 — Signed auto-update

**Status:** Blocked. **Priority:** P2 (adoption blocker)

The largest adoption blocker: "try Praxis" currently means "maintain a local
build." Build and release plumbing is done (`npm run build`); installer packaging
(DMG/MSI/AppImage) is done. **Blocked on code-signing credentials** (Apple
developer account, Windows Authenticode cert).

#### FX-BE-035 — Real GitHub backend

**Status:** Complete. **Priority:** P2 (multi-platform parity)

`GitHubBoardService` (core) + `serviceRegistry.ts`'s `case 'github'`. Modeled on
**folder**, not GitLab — GitLab's own `createIssue`/`deleteIssue`/`attachFile`/
board CRUD all throw "not implemented yet"; folder's refusals name a real
alternative instead, which is the bar GitHub's refusals are held to. One repo is
one board (labels named `status: …` synthesize the columns; a repo with none
still renders Backlog/Closed). Edits: summary, description, assignee — GitHub's
issue API has nothing resembling priority/severity/type. Creation gated behind
`allowIssueCreation`. Full e2e coverage against an in-process mock REST server
(`github.spec.ts` / `mockGitHubApi.ts`), 6 tests. Folder's own suite (13 tests
across `folder`/`folderMulti`/`editIssue`/`newIssue.spec.ts`) re-run green before
and after, confirming the addition is structurally isolated
(`getServiceForConnection` switches on `connection.mode`).

#### FX-BE-036 — Prove multi-file and terminal-using agent paths

**Status:** Planned. **Priority:** P2 (proof of capability)

The ticket-to-agent flow is proven only for single-file, no-shell edits
(scripted e2e without model calls). Needs: a multi-file fixture and a shell-command
fixture, both in the normal suite. Unblocks confidence that delivery workflows can
do real work.

---

### 2. Remaining polish items (post-FX-BF-016)

All of these are smaller than the FX-BF-016 blockers; grouped by the type of work.

**Shipped since the last audit (FX-BF-017, 2026-09-05):** command palette issue
index (workspace-wide, debounced async search), available slash commands from
the agent (ACP `available_commands_update` → composer commands chip), the
agent's own Session Mode (ACP `current_mode_update` → composer mode chip),
cost/token attribution over time (Settings → AI Provider spend report, grouped
by provider/model and connection), and workflow write-back to issue (a run can
now start from a ticket and posts its outcome back as a comment once settled —
no status transition, since Praxis has no target-status mapping for a
tracker's own workflow). Full detail in `docs/PLAN_MAP.md`.

#### UX gaps (high-value, low-effort)

| Gap | Work | Why |
|---|---|---|
| Application logs — search/export/persistence | The Output tab already tails the shared log bus live (ai/jira/gitlab/workflow tags, FX-BE-041); still a 500-line in-memory ring buffer with no search, export, or persistence across restarts. | Debugging an issue from days ago still needs file-system access. |

**Corrected in this pass:** connection status indicator (`ConnectionStatusDot.tsx`
on each sidebar connection group) and issue details peek in sidebar
(`IssuePeek.tsx`) were listed here as gaps without independent verification —
both already exist and are e2e-tested (`shellPolish.spec.ts`).

#### Deferred (Jira-coupled or lower priority)

- Import markdown feature plan/files — migration tooling, lower adoption priority.
- Migrate live folder → Jira MCP — couples to broader Jira multi-root work.
- Link Jira epic / board query to folder — deferred with above.
- Jira artifact archive — Jira-specific, low priority.
- Issue details peek in sidebar — nice-to-have; full detail pane solves the use case.
- Create idea type UI — Jira-specific mapping; low daily use.
