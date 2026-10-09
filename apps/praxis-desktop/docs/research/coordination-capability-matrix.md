# Coordination capability matrix (FX-BF-048 / TASK-391)

What each route an agent can change things through actually goes through, measured on
the machine this was built on (macOS, darwin arm64, 2026-10-09). A runtime or route not
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
| ACP `fs/write_text_file` (writes the agent routes through Praxis) | `AcpClientWrapper` | `file` | tool | `e2e/coordination.spec.ts` (real ACP subprocess refused, file untouched, reason reaches the agent) |
| In-app browser MCP (`browser_*`) | `BrowserMcpServer.beforeToolCall` | `browser` | sequence (until turn end) | `browserMcpServer.test.ts` |
| Coordination MCP (`coordination_claim`) | broker | `directory` per path, optional `browser` + `app-ui` | sequence | used by ACP agents voluntarily |
| Workflow merge stage | `runWorkflowMerge` | — (checks the branch's changed paths against `declaredPaths`) | — | `workflowMergeRunner.test.ts` |

Not gated: the gateway's own browser tool extension (it shares the in-app browser but
calls it directly), terminals a person opens, and anything an ACP agent does with its
own tools. A turn ending releases every non-service claim (`end-turn`); a deleted session
leaves the broker, and an executing claim at that moment waits for recovery.

## Native runtimes

| Runtime (installed) | Launch mode in Praxis | Before-tool hook | Proven | Status |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.295 (claude-agent-acp 0.88.0) | ACP | `PreToolUse` command hook; deny via `hookSpecificOutput.permissionDecision: "deny"` | **Yes, live.** `coordinationHook.live.test.ts` (`PRAXIS_LIVE_CLAUDE=1`): with another session holding `busy.txt`, real `claude -p` was denied on `Write` and the file stayed `original`; once released, the same prompt wrote `CHANGED` and the claim was released by `PostToolUse` / `Stop`. | Cooperative, opt-in |
| Codex 0.159.3 (codex-acp 2.1.1) | ACP | The binary carries `PreToolUse` / `PostToolUse` / `PermissionRequest` hook wire types and a `codex_hooks` feature flag | **No.** A project `.codex/hooks.json` with `-c features.codex_hooks=true` did not fire in `codex exec`, and Codex made the edit with a shell command (`printf … > busy.txt`), not an edit tool. Even a working hook would need shell parsing to name the file. | Unsupported until proven; coordination MCP only |
| Gemini CLI 0.43.0 | not an ACP host in Praxis | `gemini hooks migrate` (from Claude Code) exists | No | Unsupported until proven |
| GitHub Copilot CLI 1.0.91 | ACP (`copilot --acp`) | none found | No | Coordination MCP only |

### Claude Code hook: what it covers

- `Edit`, `Write`, `MultiEdit`, `NotebookEdit`: claimed per file before the tool, released
  after (`PostToolUse`) or at `Stop` / `SubagentStop` / `SessionEnd`.
- `Bash` is **not** claimed — its effects cannot be named up front. This is why the hook is
  cooperative, never enforced.
- No broker running (Praxis closed), an unreadable payload, a hook error or an 8 s timeout:
  the hook **allows** and says why on stderr. It never becomes the broker itself (a
  short-lived process would strand its claims).
- Session identity is `claude:<session_id>`. Subagent identity inside one Claude session is
  not distinguished — subagents share the session's claims. Unproven beyond that.
- Install is a person's choice: add `PreToolUse`, `PostToolUse` and `Stop` entries running
  `node <praxis>/out/main/coordinationHook.js` (in a packaged app, run it with
  `ELECTRON_RUN_AS_NODE=1 <Praxis executable>`), or pass them with `claude --settings`.
  Praxis does not write it into `~/.claude/settings.json`.

## Broker platform verification

| Platform | Election + socket | Status |
| --- | --- | --- |
| macOS (darwin arm64) | `broker.lock` (O_EXCL) + Unix socket `0600`, token file `0600` | Proven: `coordinationHost.test.ts` — two processes, one grant; leader `SIGKILL` → follower takes over, executing claim → `recovery-required`; live lock never taken over; unreadable state blocks grants; wrong token refused. Full e2e suite with a broker per app launch. |
| Linux | same code path | Not run here (Docker was not available) |
| Windows | named pipe `\\.\pipe\praxis-coordination-<hash>`; no file-mode protection on the pipe | Not run here; the pipe's ACL is the platform default, so the token is the only protection |

## Not delivered (tracked in TASK-393 / 394 / 395)

- Service / process-tree claims (a dev server holding a port across turns) and interactive
  command claims — the `service` lifetime exists in the broker, no host route uses it yet.
- Gates waiting in the queue: every Praxis gate asks with `wait: false` and fails fast; the
  broker's FIFO waiters, reservations and `resource-available` wakeups are tested in core
  but no agent route subscribes to them.
- Revalidating branch/HEAD at execution; manual-takeover pausing automation.
- Codex, Gemini and Copilot native adapters; Linux and Windows runs; sleep/clock-change and
  hook crash tests.
