---
**Status:** 🔄 In Progress
**Created:** 2026-10-02T10:59:50.747Z
**Type:** Task
**Priority:** Medium
id: TASK-393
type: Task
status: In Progress
created: 2026-10-02
priority: High
---

# Gate session tools and reconcile their lifecycle

## Files and integration points

main/src/main/agentSessionLauncher.ts, aiIpc.ts, browserMcp.ts; core ai/vercelAgentService.ts, tools/localTools.ts, browserMcpServer.ts, acp/acpClient.ts and acpAgentHost.ts; workflow dispatch layer.

## Scope

Register turns and wrap actual side-effect entry points. Hold full browser/app sequences; gate filesystem writes, declared task profiles, coarse unknown shell mutations, branch and build operations. Track child/service lifetimes and cleanup before release. Prototype native before-tool integration; label cooperative/observed paths honestly. Keep workflowScheduler pure and its existing serialization.

Implement runtime-specific synchronous before-tool adapters, result/failure adapters and session/turn/stop/interrupt cleanup mapping from TASK-391's capability matrix. Hooks call the shared broker and never edit the JSON authority themselves. Merge approved configuration without replacing other hooks; preflight the actual launched process and trust settings. No automatic global configuration mutation. Prevent hook recursion by exempting only authenticated broker plumbing, not resource tools.

Use stable event/request IDs so native hooks and hosted executor gates join the same reservation. Reconcile downstream permission denial and cancellation; do not automatically approve permissions. Distinguish unused grants from executing tools through actual lifecycle evidence. Handle repeated startup/resume/compaction idempotently.

Keep sequence claims across UI interactions and service/interactive command claims across polling/input/process-tree lifetime. A command wrapper or restrictive execution route must cover effects introduced without another before-hook. Bind distinct native execution/subagent owners; enforce explicit delegation and reject parent/child wait cycles. Revalidate resource/branch/HEAD and relevant input fingerprints at execution.

Emit supported explicit denials on ordinary adapter errors. Test missing/crashed/disabled/timed-out hooks separately because runtime failure may leave tools unblocked. Enforced mode requires a proven direct gate or a tool route that cannot bypass the grant check; otherwise downgrade to cooperative and refuse exclusive shared-resource access through that route. Telemetry after execution is not enforcement.

## Dependencies

TASK-391, TASK-392

## Done conditions and validation

Losing contenders never execute; Bypass/read-only boundaries remain correct; follow-up reacquires; cancelled/orphan processes keep unsafe resources blocked; prove ACP hook coverage rather than deriving prevention from notifications.

Pass the research document's two-agent UI acceptance journey and each supported runtime's denial/error/cancel/interactive/subagent fixtures. Show effective hook configuration and actual launch-mode coverage. Permission rejection releases only unused reservations; after-hook failure cannot release live services or UI sequences. Existing hooks remain present. Unsupported paths are visibly classified and never advertised as enforced.

## Description


## Comments

## Progress 2026-10-09

Delivered: gates on the gateway's `write_file` (file) and `run_shell` (whole worktree) —
**enforced**; on ACP hosted `fs/write_text_file` with the refusal reason carried to the
agent; on the in-app browser MCP as a sequence claim held until turn end; turn end and
session deletion release / recover; app joins the broker at startup. Opt-in Claude Code
hook adapter (`coordinationHook.ts`) proven live against Claude Code 2.1.295 — denial
before the losing write — never installed automatically, never the broker itself,
allowing with a stated reason on outage, malformed payload or timeout.

Remaining: service and process-tree claims, interactive command claims, revalidating
branch/HEAD at execution, Codex / Gemini / Copilot native adapters (Codex's hooks did not
fire in a probe; see the capability matrix).
