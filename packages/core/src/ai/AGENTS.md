# Agent notes: `packages/core/src/ai`

Area-specific guidance, moved out of the root [AGENTS.md](../../../../AGENTS.md).
The root file still holds the rules that apply to every change; read it too.

## Other AI tools' agents, skills and instructions (`agentRuntime/nativeSources.ts`)

Praxis reads, in place, what other AI tools keep in the project and in the user's home:
`.claude/agents|skills` + `CLAUDE.md`, `.codex/skills` + `AGENTS.md`, `.agents/skills`,
`.github/agents|skills` + `copilot-instructions.md` + `instructions/*.instructions.md`,
`.gemini/agents` + `GEMINI.md`, `.cursor/rules/*.mdc` + `.cursorrules`. The project is the
nearest `.git` above the working folder (`settings → session → PRAXIS_AI_WORKING_DIR`; never
the app's own cwd). Desktop glue: `main/nativeSourcesInstance.ts`. The Agent Runtime panel
shows them under "From other AI tools" and on its Instructions tab.

- **Precedence (same id):** Praxis project > Praxis global (incl. "Copy to Praxis") >
  native project > native user > built-in; the losers are kept in `alsoIn`.
- **Trust:** project files are untrusted until "Allow this project"
  (`ai.nativeSources.approvedProjects`, keyed by git root); user-folder files are trusted.
- **No double-loading:** every source carries `readBy` — the runtimes that load it
  themselves. `createBinding` marks such a skill `native` (instructions not injected), and
  `buildSessionInstructions` skips instruction files the session's runtime reads natively
  (`effectiveRuntime`: a custom ACP command counts as reading nothing). User-level
  instruction files are never injected; path-scoped rules are shown only; one session gets
  at most `MAX_INSTRUCTION_CHARS`.
- Native agents get a synthetic `followsSessionRuntime` host so they launch on whatever
  runtime the session uses and appear in the workflow designer palette.
- **Tests:** `launchTestApp` points `PRAXIS_NATIVE_SOURCES_HOME` at the test's user-data
  dir, so a developer's real `~/.claude` etc. never leaks in. `nativeSources.spec.ts`
  builds its own repo + home fixture.

## Agent sessions (ACP)

`packages/core/src/ai/acp/` hosts a CLI agent (Claude Code, Codex) as a subprocess over
the Agent Client Protocol. `AcpAgentHost` owns the session state machine and the events;
`AcpClientWrapper` owns the wire and serves the agent's `fs/read_text_file` /
`fs/write_text_file` requests against the session's working folder, **gated by tool mode**
(`full` writes, `read-only` reads, `project-only` neither) and sandboxed to that folder.

### What the protocol actually offers

**Read the schema before claiming ACP can't do something.** This has now cost two
mistakes in one session — `plan` and `usage_update` were each called impossible, and
each turned out to be a stable part of the spec that this host simply had no `case`
for. The switch in `handleSessionUpdate` has no `default`, so an unhandled kind is a
silent no-op that looks exactly like the protocol not supporting it.

The source of truth is the installed package, not memory:

```bash
# every update kind, and the payload type for each
grep -n "^export type SessionUpdate" -A 40 \
  node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts
```

`dist/schema/` is the stable v1 export (`import * as acp from '@agentclientprotocol/sdk'`,
what this app uses). `dist/v2/` is `experimental/v2` and is **not** what we import.
Within the stable schema, individual types are still marked `**UNSTABLE**` in their
doc comment — check for that before building on one.

`sessionUpdate` kinds in the stable schema, and where each stands here:

| Kind | Stability | Handled |
| --- | --- | --- |
| `agent_message_chunk` | stable | yes — buffered into `responseText` |
| `agent_thought_chunk` | stable | yes — `reasoningText` |
| `tool_call` / `tool_call_update` | stable | yes — `tool_start` / `tool_complete` events |
| `plan` | stable | yes — `session.taskList` |
| `usage_update` | stable | yes — `contextTokens` / `contextLimit` / `cost` |
| `user_message_chunk` | stable | no |
| `available_commands_update` | stable | no — the agent's slash commands |
| `current_mode_update` | stable | no — the agent's own mode, distinct from our `SessionMode` |
| `config_option_update` | stable | no — model picker reads config options on demand instead |
| `session_info_update` | stable | no |
| `plan_update` / `plan_removed` | **UNSTABLE** | no — the incremental multi-plan variant; `plan` is the stable one |
| `compaction_update` / `compaction_summary_chunk` | **UNSTABLE** | no |

Nothing in the "no" rows is unreachable — they are unhandled, and the table is here so
the next gap is found by reading it rather than by assuming.

- **Every turn records its reply as a `message` event.** `buildConversationTranscript`
  reads `message` events to build the next turn's prompt, so a turn that finishes without
  appending one drops the agent's own answer from the following turn's context. The
  initial-turn and follow-up paths must both do this; do not "flush" a prior reply
  retroactively on the way into the next turn (that runs after the transcript is built,
  and duplicates an event the history already holds).
- Permission approval is wired end to end: `ai:respondToPermission` → the host resolves
  the pending request, `SessionsPage` renders Allow / Always allow / Deny while the
  session sits in `awaiting_approval`.
- A full-tools `ai:delegate` **requires** an explicit `workingDirectory` — it will not
  fall back to the app's cwd. Folderless projects are coerced to `project-only`.

- **The two providers report different things, and the fields are not interchangeable.**
  API providers report cumulative tokens: the gateway wire parser reads them from both
  wire formats (OpenAI's final `usage` chunk, which the request already asks for via
  `stream_options.include_usage`, and Anthropic's `message_start` / `message_delta`
  pair), the loop emits a `usage` event per turn, and `addAgentTokenUsage` sums them
  into `tokenUsage`. ACP agents report it in two places. `usage_update` carries `used`
  (tokens **currently in the window**) and `size`, which feed `contextTokens` /
  `contextLimit`, plus an optional cumulative `cost`. The **prompt response** carries
  `usage` (tokens for the turn; experimental in the spec) and, from Claude Code and
  Codex, `_meta.quota.model_usage` naming the model(s). `recordTurnTelemetry` in
  `acpAgentHost.ts` reads the response: it puts duration, tokens, model and cost on the
  reply event (the chips under a reply) and adds the tokens to `tokenUsage`.
  **Never map `used` onto `tokenUsage`**: it is occupancy, not spend, and the two
  diverge the moment a conversation is trimmed. Anthropic also sends input and output
  in *different* events, so a running total must not be derived until the stream ends.
  Measured against the installed agents (re-run the probe if one changes):
  - `usage` is **per turn here only because every turn is a fresh agent process** that
    resumes the session — counters restart with the process (Claude Code and Copilot are
    session-cumulative within one process; Codex reports its last turn). Reusing one
    client for a second prompt would need a baseline.
  - **Cost is the opposite**: `usage_update.cost` is cumulative and survives a resume, so
    a turn's cost is the growth in the session total. Only Claude Code reports it; Codex,
    Copilot and Antigravity show no cost chip and the app does not price their tokens.
  - Claude's `model_usage` includes small internal calls (a Haiku call rode along), so
    the reply's model is the row that did the most work.
  - `packages/antigravity-acp` is ours: it returns `usage` on the response. `agy` reports
    no model and no context window, so its replies show the requested model and no ring.
- **`ai.spendLimit` is a budget the user sets, not a balance anyone reports.**
  Nothing Praxis talks to exposes credits: ACP carries a cumulative `cost` but no
  limit, and the gateway client only calls `/v1/models` and `/v1/chat/completions`.
  So never word it as "credits remaining", and never derive cost from tokens for
  API providers — that needs a price table this app has neither got nor could keep
  true. `summariseSpend` totals **per currency** and yields a comparable `single`
  total only when every reporting session used one: adding USD to EUR to fill the
  banner would be exactly the invented number this section exists to prevent. The
  warning is also explicit that nothing is blocked — Praxis cannot stop an agent
  spending, only say so.

- **The agent's self-reported task list (ACP's `plan` update — Claude Code's TodoWrite,
  Codex's plan tool) renders in `SessionInspector` as `SessionTasks`, not in the
  transcript.** A `plan` event is a complete snapshot every time ("the client replaces
  the entire plan with each update" — the spec's words), so `setAgentTaskList` replaces
  `session.taskList` wholesale rather than merging; a host that merged instead would
  still look right on a single status flip and only break once two updates arrived
  close together. It deliberately does not also become a chat message: the point is to
  stay visible and current while the transcript scrolls underneath it, not to add one
  more thing scrolling past. Absent for every non-ACP provider and for any ACP session
  that never calls the tool — most won't.

- **Context is bounded in two places, for two different reasons.**
  `compactHistoryForReplay` strips tool round-trips when a session is *continued*,
  so old tool output does not replay on every follow-up.
  `trimToolOutputToBudget` runs *inside* the turn loop and elides the oldest tool
  results once the conversation passes `DEFAULT_HISTORY_BUDGET_CHARS` — without it
  history grew monotonically until the provider rejected the turn. It replaces
  content but never removes the `role: 'tool'` message: an assistant `tool_calls`
  entry without its matching result is a protocol error. User and assistant turns
  are never touched.
- **`contextTokens` is not `tokenUsage.inputTokens`.** The former is the latest
  turn's prompt (replaced each turn) and is what context pressure means; the latter
  totals every turn. A session can spend a million tokens over fifty small turns
  without ever filling its window, so never drive a "nearly full" warning from the
  cumulative figure.
- **The facts fixed when a session started (provider, model, tool access, folder,
  worktree), the mode switch, and the context-pressure banner all live on the
  composer's `.composer-controls` row in `SessionsPage`, not in `SessionInspector`.**
  Every one of them was moved there once already — into the inspector for the
  sidebar-consolidation pass, then back to the composer because that buried them
  where the user is about to act, instead of showing them where Claude and Copilot
  both do: beside the input. Change-model and hand-over chips also live on that
  composer row (disabled while a turn is running). `SessionInspector` keeps live
  status, the session purpose, the living handover brief, runtime history, the
  task list, the changeset, and terminal actions (abort, remove worktree) —
  things to watch or act on for the session as a whole, not facts read once
  before typing a message.
- **In-flight single-agent composer: minimized by default with Ask & Queue.** While a
  single-agent turn is executing, the follow-up composer remains collapsed to a compact bar
  showing only the live tool activity, an `Ask` button (`.session-ask-button`), and the
  `Stop` button (`composer-send-cancel`). Irrelevant controls (such as the workflow selector
  or ACP mode chips) are hidden to keep the view clean. Clicking `Ask` smoothly expands
  the textarea (`placeholder="Queue follow-up (sends automatically when done)…"`) and presents
  both the `Stop` button (to abort the running turn) and a `Queue` button. Submitting enqueues
  the follow-up message into `queuedFollowUpsBySession`, collapses the input, and displays
  a queued pill (`.session-runtime-chip.is-queued`) allowing cancellation or editing. As soon
  as the active turn reaches a terminal state, the queued prompt is auto-dispatched to
  `continueSession`. If the user clears their draft or presses `Escape`, the expanded composer
  automatically collapses back to the minimized bar.
- **Session usage summary: hideable bar with composer restoration & smooth closing animation.**
  `SessionUsageSummary` carries a close button on the right edge of its `<summary>` (`.session-usage-hide-btn`).
  When hidden, preference is saved in `localStorage` (`praxis:session-usage-hidden`) and a
  restoration chip (`.session-restore-usage-btn`, graph icon + "Usage") renders on the right
  side of the session composer directly to the left of the tools button (`session-tool-mode` in
  `.session-mode-panel-meta`). Clicking this chip restores the usage bar above the composer.
  Closing the usage panel (whether hiding the bar via `.session-usage-hide-btn`, collapsing the
  expanded metrics via `<summary>`, clicking anywhere outside the open panel, or pressing `Escape`)
  smoothly animates closed from top to bottom via `.session-usage-wrapper` and
  `.session-usage-details-content` using `clip-path`, `transform`, `opacity`, and `max-height` transitions.
- **Session composer horizontal rule matches border-strong.** The horizontal line separating
  `.session-mode-panel` from the textarea inside the composer uses `border-bottom: 1px solid var(--border-strong)`
  so it seamlessly matches the composer card's resting border color when unselected.
- **`.session-mode-toggle` is one shared style for the Chat/Analysis/Review
  control, used both when a session starts (`NewSession`) and to re-run a
  finished one (`SessionsPage`'s composer).** It used to be two near-identical
  rule sets (`.session-mode-toggle` / `.session-mode-switch`) after the second
  copy was written from scratch instead of reused — don't reintroduce a second
  one if this moves again.
- **`SessionChanges` can show a changed file two ways: `getComparison` for the diff,
  `git:getFileContent` for the whole current file.** This is deliberately not an
  editor — Praxis has none by design — just "let me read it" for a file a diff's
  hunk context doesn't fully show. `getGitFileContent` reads the *working tree*
  directly (not a git object), through the same `safeRepositoryFile` sandbox
  `getGitConflict` already used, so it reflects exactly what's on disk right now,
  untracked files included, and cannot escape the repository. It caps what it reads
  at `MAX_FILE_VIEW_BYTES` (1 MB) and returns `truncated` rather than growing
  unbounded, and returns `isBinary` (a null byte in the first 8 KB) with empty
  `content` rather than dumping binary bytes as text. The diff and file panes share
  one `openPath`/`openMode` pair and are mutually exclusive — opening one closes
  the other. Highlighting (`ui/codeHighlight.tsx`) is shared with `GitDiffWorkspace`:
  one small regex-based highlighter for the languages this app actually shows, not
  a real tokenizer — reach for a real one (Prism/Shiki) only if language fidelity
  ever actually matters here.

**Testing an agent flow without a model:** `e2e/fixtures/codingAcpAgent.mjs` is a real ACP
subprocess (real SDK, real wire framing) that performs a scripted edit through the same
file-I/O handlers. Two non-obvious requirements: it needs the executable bit (the host
spawns the `cliPath` command directly, not via `node`), and it resolves
`@agentclientprotocol/sdk` from its own location because it is spawned with `cwd` set to
an arbitrary project folder. `e2e/aiCodingTask.spec.ts` is the worked example.

## Interactive ticket review

"Review ticket" is a real read-only agent session, not a one-shot prompt: only a session has a
scope for gadgets to be issued against and a conversation for answers to travel back on. The
agent gives a verdict, then asks what to do about each finding as gadgets (pick findings →
answer open questions → edit and apply the resulting ticket text). Code: `packages/core/src/ai/ticketReview.ts`
(key convention, gate, prompt), `main/src/main/ticketReviewIpc.ts` (start/lookup),
`ticketReviewApply.ts` (the write), `renderer/src/ai/AiReviewPage.tsx`, and the shared
`renderer/src/ai/gadgets/useSessionGadgets.ts` (also used by `SessionsPage`).

- **The session key is `review~<ticket key>`, never the ticket's own key.** Sessions are stored
  by issue key, so reusing it would replace the ticket's implementation session. Use
  `ticketReviewSessionKey` / `reviewedIssueKey`; the renderer mirrors the prefix in `isTicketReviewKey`
  because it cannot import core values. The prompt builders translate the key back, so the agent
  is told the ticket's real key (a test asserts `review~…` never reaches the prompt).
- **One decision gadget per reply.** Every recorded answer to a `choice`, or to a form whose
  actions are all informational, is sent back to the agent as a follow-up turn. Two decision
  gadgets in one reply would each start a turn and the agent would jump ahead. The prompt says so;
  the examples in it are validated against the real gadget schema by `ticketReview.test.ts`.
- **The apply form is the one gadget with a `mutating` action** (`TICKET_REVIEW_APPLY_GATE`).
  `gadgetIpc.executeGadgetAction` routes it to `applyTicketReview`, which refuses any session
  that is not a ticket review. This is the second exception, after workflow approvals, to
  "a gadget records a decision and never reaches a service": the user's own click on an editable
  form is the approval, and the agent cannot write to the tracker itself (the session is
  read-only; CLI agents have no tracker tools at all).
- **Apply refuses to overwrite an edit made after the review started.** It compares the ticket's
  description/summary to what the review last read or wrote — not the tracker's `updated`
  marker, which a comment (including "Post as comment") also bumps.
- **The apply form's textarea must use the `.textarea` class.** `.input` fixes the height at 28px
  and collapses a whole ticket description to one line.
- **e2e:** `e2e/aiTicketReview.spec.ts` drives `e2e/fixtures/ticketReviewAcpAgent.mjs`, a real ACP
  subprocess with a fixed script — the session, gadget pipeline, follow-up turn and apply are the
  production path; only the model's words are canned.
