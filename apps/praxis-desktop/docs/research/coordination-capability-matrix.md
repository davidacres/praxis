# Coordination capability matrix (FX-BF-048 / TASK-391)

What each route an agent can change things through actually goes through, measured on
the machine this was built on (macOS, darwin arm64, 2026-10-09; updated the same day with
service, waiting, takeover, clock and native-adapter evidence). A runtime or route not
proven here is **unsupported until proven** — not presumed compatible. Nothing below
was obtained by editing a global configuration file; every live probe used a per-run
flag (`claude --settings <file>`, `codex -c …`) and a throwaway repository.

## Coverage levels

| Level | Meaning | Where it applies |
| --- | --- | --- |
| **enforced** | The side effect runs through a Praxis gate that asks the broker first; a refusal means it does not happen. | Gateway (API provider) sessions: `write_file`, `run_shell` |
| **cooperative** | Praxis gates only what the agent routes through Praxis or claims itself; its own tools can bypass. | Every ACP session (Claude Code, Codex, Copilot, Cursor, Antigravity); the opt-in Claude Code hook |
| **observed** | Praxis sees the session but cannot stop its changes. | Reserved; nothing is labelled observed today |

The inspector shows the session's level (`session-coordination-coverage`), with the
meaning in its tooltip.

## Praxis-owned routes

| Route | Gate | Resource claimed | Lifetime | Proof |
| --- | --- | --- | --- | --- |
| Gateway `write_file` | `LocalToolExecutor` → `CoordinationGate` | `file` | tool | `localTools.test.ts` (refused write never touches disk) |
| Gateway `run_shell` | same | `worktree` (a command can touch anything) | tool | same |
| Processes a `run_shell` command leaves running (macOS/Linux: the command is its own process group) | `trackService` in `localTools.ts` | `process` (the group) + each `port` it listens on, claimed as they open | service — until the group exits or is stopped; kept across turns | `localTools.test.ts` (a backgrounded server returns at once, claims its port, Stop releases with evidence; a timeout stops the whole group); `e2e/coordinationWait.spec.ts` (Stop in the inspector) |
| Gateway `wait_for_files` / ACP `coordination_wait` | `waitForResources` | `directory` per path (+ `browser`/`app-ui` for the MCP's `app`) | sequence, from a fresh grant | `coordinationInstance.test.ts` (woken on release; timeout, cancel and turn end leave nothing queued and grant nothing late); `e2e/coordinationWait.spec.ts` |
| ACP `fs/write_text_file` (writes the agent routes through Praxis) | `AcpClientWrapper` | `file` | tool | `e2e/coordination.spec.ts` (real ACP subprocess refused, file untouched, reason reaches the agent) |
| In-app browser MCP (`browser_*`) | `BrowserMcpServer.beforeToolCall` | `browser` (this app instance's own surface, `in-app:<pid>`) | sequence (until turn end) | `browserMcpServer.test.ts` |
| A person clicking, typing or scrolling in the in-app browser | `aiBrowser.ts` `input-event` → `personUsedBrowser` → broker `takeover` | `browser`, moved from the agent to `person:<pid>` | until 30 s without input | `coordinationInstance.test.ts`; `e2e/coordinationWait.spec.ts` (a real input event takes it; the agent is told its view is out of date and refused until handed back) |
| Coordination MCP (`coordination_claim`) | broker | `directory` per path, optional `browser` + `app-ui` | sequence | used by ACP agents voluntarily |
| Workflow merge stage | `runWorkflowMerge` | — (checks the branch's changed paths against `declaredPaths`) | — | `workflowMergeRunner.test.ts` |

Not gated: the gateway's own browser tool extension (it shares the in-app browser but
calls it directly), terminals a person opens, and anything an ACP agent does with its
own tools. A turn ending releases every non-service claim (`end-turn`); a deleted session
leaves the broker, and an executing claim at that moment waits for recovery — a service
claim whose processes then exit is cleared by Praxis with that as evidence.

**Before every gated write or command** the gate also compares the checkout's branch and
HEAD with what the session last acted on. A move the session did not make itself (its own
commands' moves are its new baseline) refuses that one write with what changed, so the
agent re-reads before acting on stale files; the next attempt proceeds.

**Interactive commands.** No Praxis agent route sends input to a running command: `run_shell`
runs with stdin closed, and ACP terminals are not advertised. Native routes that do (Codex's
`write_stdin`, which does not re-run a before-hook) are outside every gate, which is one more
reason native shells are cooperative.

**Time.** The broker judges leases on a monotonic clock, so changing the system clock moves
none. A gap between its beats (the machine slept, the process was stopped) extends every
lease by the gap before any is judged; an owner that is really gone still expires one lease
after waking (`coordination.test.ts`, `coordinationHost.test.ts`).

## Native runtimes

The hook adapter is one script, `coordinationHook.js`, with `--runtime claude|codex|copilot|gemini`.
Each runtime speaks its own payload and denial format; every one claims only file-editing
tools — shell commands are never claimed, because their effects cannot be named up front.

| Runtime (installed) | Launch mode in Praxis | Edit tools claimed | Denial format | Proven | Status |
| --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.295 (claude-agent-acp 0.88.0) | ACP | Edit, Write, MultiEdit, NotebookEdit | `hookSpecificOutput.permissionDecision: "deny"` | **Yes, live** (`PRAXIS_LIVE_CLAUDE=1`): denied before the losing write, file unchanged; same prompt writes once released; claims released by `PostToolUse` / `Stop`. | Cooperative, opt-in |
| Codex 0.159.3 (codex-acp 2.1.1) | ACP | `apply_patch` — every file in its Add/Update/Delete/Move headers, all or none | same as Claude Code | **Yes, live** (`PRAXIS_LIVE_CODEX=1`): `apply_patch` blocked by the `PreToolUse` hook with the holder named, file unchanged, the agent stopped; released, the patch applied and `Stop` released its claims. | Cooperative, opt-in |
| GitHub Copilot CLI 1.0.91 | ACP (`copilot --acp`) | `edit`, `create` (`toolArgs.path`) | `permissionDecision: "deny"` | Adapter built and tested against the contract in the installed CLI (`.github/hooks/*.json`, `preToolUse` input `{sessionId, cwd, toolName, toolArgs}`); **not live**: this account's monthly quota is exhausted, so no tool call could be made. | Unproven live — not advertised |
| Gemini CLI 0.43.0 | not an ACP host in Praxis | `write_file`, `replace` (`tool_input.file_path`) | `decision: "deny"` | Adapter built and tested against the contract in the installed CLI (`BeforeTool`, hooks on by default); **not live**: the service refuses this account (`UNSUPPORTED_CLIENT`, "migrate to Antigravity"). | Unproven live — not advertised |

### What every hook adapter covers

- Before an edit tool: claim each file (all or none), deny with the holder and reason if
  any is held. After it: release. At the session's own `Stop` / `SessionEnd`: release the rest.
  A **subagent** stopping does not end its parent's turn.
- **No broker running** (Praxis closed): the hook allows and says why on stderr — Praxis is
  optional. It never becomes the broker itself (a short-lived process would strand claims).
- **A broker that is running but errors, dies mid-request, or does not answer within 8 s**,
  and the hook itself failing: the edit is **denied**, with why, and the message says it was
  not another session (`coordinationHook.test.ts` — a silent broker and a crashing one).
- **A hook process that crashes outright** is the runtime's to handle, and Claude Code then
  runs the tool (proven live: a hook killed with SIGKILL, the write happened). This is why a
  hook route is cooperative, never enforced.
- Session identity is `<runtime>:<session_id>`; subagents share their session's claims.
- A tool the person then refuses at the runtime's own permission prompt fires no after-tool
  hook: its file claim is held until the session's `Stop` releases it — bounded by the turn.
- **Installing is a person's choice.** Praxis writes no one's configuration:
  - Claude Code: `PreToolUse`, `PostToolUse` and `Stop` entries running
    `node <praxis>/out/main/coordinationHook.js` (in a packaged app,
    `ELECTRON_RUN_AS_NODE=1 <Praxis executable> …`), or pass them with `claude --settings`.
  - Codex: the same events in `.codex/hooks.json` with `--runtime codex`; Codex asks a person
    to review a new hook before it runs (hook trust) and needs `features.hooks`. The probe that
    failed earlier failed only on that review; the live test grants both for its one
    invocation (`--dangerously-bypass-hook-trust --enable hooks`) in a throwaway repository.
  - Copilot: `.github/hooks/praxis.json` with `preToolUse` / `postToolUse` / `agentStop`
    commands passing `--runtime copilot --event pre|post|stop` (its payload has no event name).
  - Gemini: `BeforeTool` / `AfterTool` / `AfterAgent` in `.gemini/settings.json` with `--runtime gemini`.

## Broker platform verification

| Platform | Election + socket | Status |
| --- | --- | --- |
| macOS (darwin arm64) | `broker.lock` (O_EXCL) + Unix socket `0600`, token file `0600` | Proven: `coordinationHost.test.ts` — two processes, one grant; leader `SIGKILL` → follower takes over, executing claim → `recovery-required`; live lock never taken over; unreadable state blocks grants; wrong token refused. Full e2e suite with a broker per app launch. |
| Linux | same code path (Unix socket, `ps`/`lsof` for process groups and ports) | **Deferred** — see TASK-438 |
| Windows | named pipe `\\.\pipe\praxis-coordination-<hash>`; no file-mode protection on the pipe; `run_shell` keeps plain `exec` (no process groups, so no service tracking) | **Deferred** — see TASK-438 |

## Known limits

- A process that calls `setsid` (or double-forks into a new session) leaves the command's
  process group and is not tracked as a service.
- Ports are found with `lsof`; one a service opens is claimed within a poll (2 s) of opening.
- Only a service this app instance started can be stopped from its inspector.
- Copilot and Gemini adapters are unproven live (quota / account), so neither is advertised.
