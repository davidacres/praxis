# Agent session communication and resource coordination

Research and design proposal, 2 October 2026. Planning only; no runtime behaviour has been implemented or verified.

## Recommendation and requirement

Provide the requested `agent.sessions.chat.json` as a readable view of session activity, messages, and resource ownership. A single local coordinator must atomically grant ownership before an agent starts a conflicting action. Agents submit updates through a small API/MCP interface; they do not independently read, modify, and overwrite the JSON document.

The requirement has four parts: presence (who is active), intent (what they plan to do), ownership (what they are allowed to touch now), and handoff (what finished and what is safe for the next agent). A free-text chat log addresses presence and handoff but cannot prevent two agents from observing an idle app and both starting automation. Even atomic file replacement cannot prevent that check-then-act race or lost updates between independent writers.

The first release coordinates participating sessions on one machine and OS user, across projects, workflow runs, runtimes, and linked worktrees. It does not promise enforcement against unrelated terminals, people, remote machines, or native agent tools that bypass the coordinator. External agents can participate through the same authenticated local interface. Do not equate advisory declarations with enforced ownership.

## Current Praxis evidence

These paths were inspected in the current dirty checkout; unrelated edits were left untouched.

| File | Existing behaviour and proposed seam |
| --- | --- |
| `packages/core/src/workflows/workflowScheduler.ts` | Serializes mutating stages within the supplied run. Keep this deterministic scheduler pure; acquire actual shared resources in the dispatch/orchestration layer. Independent runs and chat sessions require broader coordination. |
| `packages/core/src/ai/agentTypes.ts`, `aiSessionManager.ts` | Existing session identities, durable records, statuses and events. Link coordination records to these identities rather than inventing a second conversation system. |
| `apps/praxis-desktop/main/src/main/agentSessionLauncher.ts`, `aiIpc.ts` | Session launch/follow-up, effective working folder and optional worktree branch metadata. Register each active turn and its ancestry; unregister only after tool cleanup. |
| `packages/core/src/ai/agentRuntime/agentLoop.ts` | Emits tool start, executes through `toolExecutor.execute`, then emits completion. Gate before execution; a displayed start event is not proof of a reservation. |
| `packages/core/src/ai/vercelAgentService.ts`, `tools/localTools.ts` | Gateway execution routing, local filesystem and shell commands. Wrap actual execution and track child processes. |
| `packages/core/src/ai/acp/acpClient.ts` | Hosts ACP filesystem writes and permission callbacks; launches the native agent subprocess. Gate hosted writes, but native subprocess tools may run without a client permission request. |
| `packages/core/src/ai/acp/acpAgentHost.ts` | Tool notifications and session lifecycle. Use notifications for observability; distinguish observed from enforced operations. |
| `packages/core/src/ai/browserMcpServer.ts`, `apps/praxis-desktop/main/src/main/browserMcp.ts` | Per-session MCP endpoints drive one shared BrowserBridge. Extend the session-bound API with coordination and gate the browser itself. |
| `apps/praxis-desktop/main/src/main/aiBrowser.ts` | A single WebContentsView and persistent browser partition. Hold ownership across the whole navigate/read/click sequence, not only each call. |
| `apps/praxis-desktop/main/e2e/launchTestApp.ts` | Isolates profile/settings and assigns a mobile port. Preserve these boundaries; additionally isolate builds, fixtures, outputs and global computer input where relevant. |

Existing multi-AI and shared-subagent plans are related design context: FX-BF-035 and FX-BF-047. This feature does not depend on their unfinished work or replace their conversation semantics.

## Research and alternatives

| Approach | Benefits | Limits | Decision |
| --- | --- | --- | --- |
| Each agent edits one JSON file | Very small initial interface | Lost updates, check-then-act race, corrupt writes, unreliable cleanup | Reject as ownership authority |
| JSON plus a cross-process file lock | Keeps readable state; can serialize check-and-update | Every writer must follow one protocol; stale takeover and orphan tools remain hard | Suitable for electing/protecting the single broker, not the agent workflow protocol |
| Single local broker plus JSON snapshots | One grant queue, authenticated identities, multi-resource requests, direct host integration | Broker lifecycle/recovery must be engineered | Recommended first release |
| SQLite transactions plus JSON export | Established multi-process transaction and recovery machinery | Additional persistence integration; transactions still cannot stop a tool holding an expired lease | Revisit if multiple independent writers or high event volume become necessary |
| Distributed service | Cross-machine coordination | Authentication, availability and operations beyond current local requirement | Deferred |

Primary sources read:

1. [Node filesystem documentation](https://nodejs.org/api/fs.html): concurrent modifications require care; repeated writes without waiting are unsafe. This supports serializing writers. Temporary-file replacement protects readers from partial snapshots; it is not the resource acquisition algorithm.
2. [proper-lockfile maintainer documentation](https://github.com/moxystudio/node-proper-lockfile): mkdir-based locking, periodic mtime updates, stale thresholds and compromised-lock detection. It also documents gaps around manual deletion and inconsistent thresholds. Assess this as a broker election helper; do not claim a heartbeat timeout safely ends a browser or shell process.
3. [SQLite locking and recovery documentation](https://www.sqlite.org/lockingv3.html): rollback-mode locks and journals provide transactional concurrency and crash recovery. This page is specifically about rollback mode, not WAL. SQLite is a credible alternative authority, not a reason to introduce a database for the current small single-writer design.
4. [Git worktree documentation](https://git-scm.com/docs/git-worktree): linked worktrees separate checkout state while sharing repository resources. `git worktree lock` prevents pruning/movement/removal; it does not reserve editing or UI automation.
5. [Git rev-parse documentation](https://git-scm.com/docs/git-rev-parse): `--git-common-dir` identifies shared Git administration. Resolve and canonicalize this directory for repository identity; branch names alone do not identify a checkout.
6. [ACP tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls): agents report tool execution through notifications and MAY request permission. Notifications alone are not a mandatory before-execution hook.
7. [Playwright isolation](https://playwright.dev/docs/browser-contexts): isolated contexts reduce browser-state interference. They do not isolate a shared live Electron app, desktop focus, build outputs, ports or external fixtures. Prefer genuinely separate environments where possible.

The recommended architecture is a synthesis of these sources and the inspected Praxis call sites, not a claim that any source supplies a complete agent coordination protocol.

## Storage, scope and naming

Use one authoritative broker root in a stable OS-user-local Praxis coordination directory, independent of Electron's per-profile `userData`. Its canonical snapshot is `agent.sessions.chat.json`; this exact user-requested name is an intentional exception to the repository's normal `<name>.praxis.<ext>` convention. It is ephemeral machine state and must not be committed, copied into worktrees, or synchronized through Git/cloud storage.

Agents discover a scoped read-only projection at `<git-common-dir>/praxis/agent.sessions.chat.json`. Every linked worktree therefore sees the same repository view. The broker's canonical file also covers host-wide resources across different repositories. Projections carry authority epoch and revision; they are convenient visibility, never evidence that a resource remains available. Clients must call acquire before executing. Do not place authentication tokens in a projection.

For non-Git folders, use canonical folder identity with the same broker and an optional local `.praxis/coordination/agent.sessions.chat.json` projection. For folderless sessions, expose only resources and messages explicitly in their scope. Test brokers use an explicit temporary coordination root; two contender apps in a test share that root intentionally. Production profiles share the stable broker root. Unsupported network/cloud-synced roots must be refused for authoritative state.

One broker owns all state changes and publishes scoped snapshots. Initial election must use a tested cross-process exclusivity mechanism. Losing election connects to the elected broker. A contender must not delete a stale-looking election lock and start another broker while the previous owner might still run. Startup validates ownership identity; ambiguous ownership blocks grants. Prototype local IPC and election on macOS, Windows and Linux before choosing a dependency. Bind authenticated local IPC only; restrict directory permissions/ACLs to the OS user.

## JSON contract, illustrative snapshot

```json
{
  "schemaVersion": 1,
  "authorityId": "local-user-coordinator",
  "epoch": "broker-start-uuid",
  "revision": 42,
  "updatedAt": "2026-10-02T10:00:00Z",
  "sessions": [
    {
      "sessionId": "session-a",
      "turnId": "turn-3",
      "parentSessionId": null,
      "runtime": "acp",
      "coverage": "cooperative",
      "repositoryId": "repo-uuid",
      "worktreePath": "/example/praxis-ui",
      "branch": "feature/session-coordination",
      "headCommit": "recorded-commit-id",
      "state": "active",
      "activity": "Automating the live app settings screen",
      "editingFiles": ["renderer/src/settings/SettingsPage.tsx"],
      "activeToolIds": ["tool-ui-1"],
      "heartbeatAt": "2026-10-02T10:00:00Z"
    }
  ],
  "claims": [
    {
      "claimId": "claim-7",
      "ownerSessionId": "session-a",
      "ownerTurnId": "turn-3",
      "resource": {"kind": "app-ui", "scopeId": "live-app-instance"},
      "mode": "exclusive",
      "state": "held",
      "generation": 7,
      "expiresAt": "2026-10-02T10:01:30Z",
      "reason": "UI verification"
    }
  ],
  "messages": [
    {
      "eventId": "event-41",
      "sequence": 41,
      "type": "activity",
      "fromSessionId": "session-a",
      "toSessionId": null,
      "at": "2026-10-02T10:00:00Z",
      "text": "Using the live app until verification finishes",
      "claimIds": ["claim-7"]
    }
  ],
  "pendingRequests": [],
  "lastEventSequence": 41
}
```

This example demonstrates shape, not a final schema or implemented API. Runtime details must additionally record host instance/process identity, actual tool lifecycle and requested resources. File lists describe intent; active claims determine ownership. Null branch handles detached HEAD. Track checkout branch changes from Git, not only agent prose. An ownership token is a separate session-bound capability, never a grant copied from the readable snapshot.

Use typed events: activity, resource-requested, resource-acquired, resource-blocked, resource-released, done, failed, cancelled, stale, recovery-required, message and acknowledged. Event IDs, monotonic sequence and idempotency keys make retries safe. Suggested snapshot cap: 500 recent events; retain terminal sessions for 24 hours, configurable. Preserve unresolved claims and waiters regardless of retention. If longer history is needed, use a broker-only `agent-session-events.praxis.jsonl` journal with rotation. Messages must not implicitly issue commands or grant permission.

## Atomic acquisition and conflict policy

Expose register, list, publishActivity, acquire, renew, release, postMessage, acknowledge and finish through a session-bound interface. Derive owner identity from authentication; never trust a submitted owner ID. Each acquisition includes a request ID, resource set, reason and wait policy. The broker checks conflicts and commits all grants as one operation or grants none. Return owner, reason, waiting state and retry guidance on contention. Enqueue FIFO among conflicting requests, allow independent resources to progress, bound waiting, and support cancellation. Avoid incremental lock acquisition and read-to-write upgrades while holding a claim; request the full required set or release and retry.

| Resource | Scope and conflict rule |
| --- | --- |
| File edit | Canonical worktree path plus canonical file path; exclusive writes. A directory claim conflicts with descendants. Resolve symlinks and existing parent paths for new files; handle platform case rules. Different worktrees can edit corresponding files concurrently. |
| Worktree mutation | Coarse exclusive claim for arbitrary shell/native edits whose affected files cannot be proven. Conflicts with file edits and stable-read/test claims in that worktree. Known independent file edits can use narrow claims. |
| Stable checkout read | Shared claim for builds, reviews or tests that require unchanged inputs; blocks relevant mutations for the duration. Ordinary read_file need not reserve a whole worktree. |
| Checkout/branch operation | Exclusive checkout-wide claim; blocks edits, stable reads and index mutations. Record expected branch/HEAD and revalidate at execution. |
| Git administration | Resource per worktree index for staging/committing; repository-level resource for explicitly shared refs/worktree administration. Ordinary edits in another worktree must not be globally serialized. Git's own locks remain authoritative for Git internals. |
| Live app UI | Exclusive per actual Electron app instance for the full interaction sequence, including screenshots and reads used by the test. Separate worktrees do not separate this app instance. |
| In-app browser | Exclusive per browser surface for the whole navigation/inspection sequence. Reject access from other sessions while held; stale element refs must be invalidated across handoffs. |
| Desktop control | Exclusive per machine/OS-user desktop when tools change global focus or mouse/keyboard state. Separate app instances still conflict here. |
| Build output | Exclusive per actual output directory for build/copy operations; shared consumption claim for tests using those artifacts. Include branch/commit and dirty-input fingerprint in the test handoff. |
| Profile, port and fixture | Scoped ownership of the actual shared profile/data/port where isolation is absent. Prefer unique temporary profiles, OS-assigned ports and fixture namespaces. A declared port does not replace OS bind checks. |

Unknown shell commands default to a worktree mutation claim plus declared external resources. Do not infer all side effects from command-name regexes. Known task profiles can declare browser/app/build/port dependencies; undeclared external side effects remain a coverage limitation. Manual/Auto/Bypass permission settings cannot bypass contention checks. Ownership does not expand tool mode or permissions.

## Lifecycle and recovery

1. Register at active-turn start, publish intent, and acquire before a relevant side effect. Show a waiting state if busy; allow independent work where it genuinely has no conflicting resource.
2. Broker-controlled heartbeats renew claims while the owning turn/tool is alive. Starting values: 15-second heartbeat, 90-second lease; tune through pause/sleep tests. Use monotonic elapsed time while running and mark claims suspect after sleep or restart rather than trusting wall-clock expiry.
3. Release per operation in finally-style cleanup. A completion handoff identifies affected files, branch/commit, test command, output/artifact identity, remaining child processes and result. Turn completion is not session deletion: idle conversations persist without resource claims and reacquire on the next turn.
4. Cancellation or failure first stops/waits for managed tools and verifies they have relinquished the resource. A spawned dev server can outlive a tool result; transfer it to an explicitly tracked service owner or retain its claim. A `done` text message is not enough to free a live process.
5. On expired heartbeat or broker crash, mark claims suspect/recovery-required. Reject old epoch/generation capabilities at every host-controlled side-effect entry point. Regrant only after confirmed managed-process shutdown, safe resource reset, or verified liveness reconciliation. If native/unmanaged work may still be running, keep the resource blocked pending explicit recovery; never silently expire and reassign it.
6. On broker loss, adapters stop accepting new side effects; abort managed tools where possible. Fencing cannot retract a syscall already underway or stop an unmanaged native process. Recovery must account for both.

Persist state before acknowledging a grant. Single writer creates a unique temporary snapshot in the same directory, flushes it, replaces the canonical snapshot and handles platform-specific replacement failure without granting from unpersisted state. Reconcile grants after acknowledgement loss using idempotency keys. On restart validate the schema and prior state; truncated/unknown state must not be interpreted as an empty registry. Keep the prior valid snapshot or recover from a journal; otherwise block grants until reconciliation. Scoped projection failure may reduce visibility without releasing authoritative claims. Filesystem watch events prompt a reread; use revisions and periodic resync because notifications may be missed. Power-loss durability and directory flush semantics require platform verification.

## Enforcement and communication

Gateway local writes/shell calls and Praxis browser operations can be gated directly. Hosted ACP fs/write requests can be gated before writing. Native ACP tools may bypass both filesystem hosting and optional permission callbacks; tool_start telemetry can arrive too late. Require a supported native before-tool hook or coordination MCP call for cooperative operation, and report coverage as enforced, cooperative or observed-only. Do not advertise universal prevention until each runtime's paths have been proven. Unintegrated sessions should use separate worktrees and avoid shared live UI; unknown shared-resource access remains explicitly unsupported.

## Native agent hooks and integration contract

Hooks are a first-class adapter to the same broker, not independent JSON writers. Use synchronous before-tool hooks for acquisition/denial, after-tool hooks for results and cleanup signals, and session/turn hooks for registration and handoff. Background hooks are suitable for noncritical telemetry only. No hook grants permission, changes tool mode, or overrides another runtime policy.

Current official documentation, checked 2 October 2026:

| Runtime | Documented hook support | Design consequence |
| --- | --- | --- |
| Claude Code | `PreToolUse` can deny built-in and MCP tool calls. `PostToolUse` reports results. Asynchronous hooks cannot block behaviour. [Reference](https://code.claude.com/docs/en/hooks). | Use a synchronous before-tool adapter; prove the chosen handler type's failure and cancellation behaviour in the installed runtime. |
| Codex | `PreToolUse`/`PostToolUse` cover shell, `apply_patch`, MCP and other local tools, with exceptions. `write_stdin` does not rerun the before-hook. MCP hook errors/unavailable servers do not block; some callback failures can leave execution unblocked. Subagent hook input can use the parent's session ID. [Official reference](https://learn.chatgpt.com/docs/hooks). | Native hooks alone do not justify an enforced label. Keep reservations across interactive command lifetimes, bind distinct execution owners and verify failure paths. |
| Gemini CLI | `BeforeTool` can deny execution; `AfterTool` reports tool output. Built-in and MCP names can be matched. [Reference](https://geminicli.com/docs/hooks/reference/). | Translate its event and denial schema into the common adapter; prove the installed runtime's behaviour. |

These are documented capabilities, not proof of support or configuration in this checkout. TASK-391 first records installed runtime version, launch mode (including ACP), enabled/trusted hook configuration, event payloads, covered tools and failure semantics. Task output is a capability matrix. Gateway sessions use Praxis's direct executor gate instead of native hooks. Native runtimes without verified adapters can still participate cooperatively, but must not use an exclusive shared UI under an enforced-mode claim.

| Lifecycle point | Broker interaction and required outcome |
| --- | --- |
| Session start/resume | Bind the authenticated Praxis session to the native session and execution owner; register actual worktree/branch/HEAD. Deliver a bounded coordination snapshot. Repeated startup/compaction must not duplicate owners or clear live claims. |
| Turn start | Create an active turn identity; reconcile prior tools and pending messages before new work. Keep idle conversation records separate from live execution. |
| Before tool | Normalize declared resources, validate permissions and acquire atomically using a stable request/tool ID. Proceed only after a durable grant. On contention, return the runtime's supported denial with owner/reason and retry guidance; never treat a stale snapshot or broker error as availability. |
| After tool / failure | Record result, reconcile actual process lifetime and release only operation-scoped claims whose side effects have ended. A failing after-hook does not prove cleanup; host/process evidence must reconcile it. |
| Stop / interrupt / session end | Mark the turn ending, cancel queued requests and publish a handoff after cleanup. Retain live service/orphan claims. These callbacks are best-effort and cannot be the only cleanup mechanism. |
| Crash / missing callback | Broker liveness tracking and host process supervision mark recovery-required; they do not infer safety from an absent end hook. |

### Failure, nesting and installation rules

1. Keep hook calls short and deterministic. On contention, deny promptly and expose a bounded broker wait/subscription operation rather than sleeping until a hook timeout. Resource-available notifications may wake an opted-in waiting turn once; ordinary presence events must not create autonomous LLM turns. Cancellation removes the pending request. After a bounded wait, report the blocker and allow unrelated work or a user-directed stop; do not spin or hammer retry prompts.
2. Catch ordinary broker errors and emit a supported explicit denial. Separately test hook crash, timeout, malformed output, disabled hooks and missing configuration: a runtime can fail open before the adapter returns. For enforced shared-resource access, require a directly gated executor/tool wrapper with validated ownership, or constrain tools so the unguarded route is unavailable. Otherwise label the path cooperative and refuse that path in enforced mode. Killing an agent after telemetry observes a tool is not a before-execution guarantee.
3. Distinguish reserved (not started), executing, cleaning-up, released and recovery-required claims. Acquisition followed by another permission hook's denial, user rejection or cancellation must reconcile the unused reservation; an absent completion event alone cannot distinguish an unused grant from running work. Deduplicate requests by execution owner/tool ID. A host gate and native hook observing the same call must join the same grant rather than queue behind themselves. Map event ordering and correlation during runtime preflight; ambiguous execution remains blocked for recovery.
4. Preserve sequence/service claims separately from tool claims: a browser read must not release the enclosing UI-test claim. A long-lived shell or yielded command retains ownership through polling/input and until its process tree finishes. Interactive shells can introduce new side effects without another before-hook; use a gated command wrapper, restrict input, or reserve a declared conservative resource set for their whole lifetime. Unknown external effects remain unsupported. Do not rely on tool-name matching to discover everything a shell can do.
5. Identify claims by `(Praxis session, turn, execution owner, tool/request ID)`, including a distinct native subagent identity when available; a hook process PID is not the agent identity. Parent/child relationships do not confer shared authority. Explicit delegation transfers the claim to one child while suspending parent access; parent exit cannot release a child's live work. Sequential calls by the same execution owner can reuse a sequence claim, but parallel sibling calls still conflict. A parent waiting for a child must not retain a resource the child needs; release/restructure before dispatch or reject the dependency with a concrete explanation. Test self-reentrancy and parent/child wait cycles.
6. Before a side effect, revalidate canonical resource identity, branch/HEAD and any plan/build input fingerprint relied on by the request. Ownership prevents participating mutations, not manual Git operations, external symlink changes or human intervention. A changed identity invalidates the reservation and associated test evidence; reconcile and reacquire. Do not silently execute against a different checkout/resource.
7. During future implementation, merge approved coordination configuration without replacing existing user/project hooks. Never patch global agent configuration automatically. Use the runtime's supported trust/setup mechanism, preflight the actual launched process, and show missing coverage plainly. The current task changes planning documents only. Installing hooks is a separate implementation action; this plan is not authorization to alter global settings.
8. Persist enough broker activity to support bounded messages and completion receipts while keeping tokens out of readable JSON. Give each client only its authorized project messages; cross-project contention can expose a minimal busy resource/reason without leaking the owning project's paths or chat. Bound message size, publication rate, pending requests and session count with explicit errors, never by evicting live claims. Claim heartbeats come from supervised execution, not merely a connected idle native session.

### Two-agent UI acceptance journey

Agent A announces UI verification and acquires the actual app/browser sequence resources before navigation. Agent B, including from another worktree, requests the same surface; its before-hook or direct gate returns busy and no UI side effect occurs. B records waiting and can perform independent work. A records results and confirms process/sequence cleanup; the broker releases ownership and notifies B. B explicitly retries, obtains a new grant and refreshes browser references before acting. Repeat with A cancelled, A killed, a failed hook and a surviving child process; B must not receive the resource while the prior action may still run. Repeat against two isolated app instances to prove that unnecessary global serialization has not been introduced.

## Design gap review and disposition

Review performed 2 October 2026 after adding native hooks. “Addressed” below means specified in the plan, not implemented or verified.

| Gap found | Required correction | Owner / status |
| --- | --- | --- |
| Hook support mentioned without exact adapter lifecycle or launch-mode proof | Runtime capability matrix and register/acquire/result/end mapping | TASK-391, TASK-393; addressed in design |
| Hook failure could allow a conflicting tool to run | Explicit denial plus end-to-end gate proof; cooperative downgrade if any unguarded route remains | TASK-393, TASK-395; addressed in design, runtime proof open |
| Permission rejection after acquisition could leak a claim | Reserved/executing state and request correlation with permission/cancellation reconciliation | TASK-391, TASK-393; addressed in design |
| Parent, native subagent and hook PIDs could share or release the wrong ownership | Distinct execution owner, explicit delegation and parent/child cycle prevention | TASK-391, TASK-393, TASK-395; addressed in design |
| Each after-hook could release an entire UI sequence too early | Separate tool, sequence and service claims; retain through actual process/input lifetime | TASK-393, TASK-395; addressed in design |
| Blocking inside hooks could time out or cause model retry loops | Prompt denial, bounded wait API, cancellation and deduplicated opted-in wakeup | TASK-392, TASK-394; addressed in design |
| Session start could rerun or coordination hooks could recurse | Idempotent session/turn mapping; exempt only authenticated broker plumbing, never resource tools; prevent adapters calling themselves | TASK-393, TASK-395; addressed in design |
| Hook setup could overwrite existing configuration or be inactive under ACP | Preserve other hooks, supported trust/setup and launched-process preflight | TASK-391, TASK-393; addressed in design |
| External branch/resource changes could invalidate a previously granted operation | Identity/HEAD/input revalidation and invalidated evidence | TASK-393, TASK-395; addressed in design |
| Global broker visibility and load were underspecified | Scoped messages, minimal contention disclosure, bounded queues/events and explicit backpressure | TASK-392, TASK-394; addressed in design |

Remaining feasibility gates are broker election/recovery and OS durability semantics, native hook event correlation/failure coverage, safe process-tree cleanup and runtime configuration compatibility. A supported-runtime coverage report and the above acceptance journey must pass before that runtime is advertised as enforced. Ship verified host-owned paths first if native coverage remains cooperative. No distributed or adversarial enforcement guarantee is added by this review.

Each agent sees a bounded initial coordination summary and event deltas since its last sequence. On reconnect, send a new snapshot if events were compacted. Messages can be targeted or broadcast within authorized project/resource scope. Require acknowledgement for handoff requests that need a response, but do not automatically create LLM conversations for heartbeats or every event. Unacknowledged messages do not block release unless a specific protocol says they must. Cross-agent text is untrusted data, not a higher-priority instruction; redact secrets/raw tool arguments and do not share whole conversation transcripts or file contents by default.

Renderer status can later show owner, resource, reason and waiting duration using existing session surfaces. Preserve manual user control: if a person takes over a reserved UI, pause/abort automation and invalidate its evidence instead of silently continuing. No force-release control should make an active orphan tool safe merely by removing its row.

## Delivery sequence and proof

Implement in five reviewable tasks: schema/resource policy and native hook capability preflight; single-broker persistence/election; gateway/ACP/browser/tool lifecycle adapters; bounded messages and session waiting status; contention/recovery/platform evidence. Establish native hook feasibility during TASK-391 before committing to the adapter architecture; prove installed launch-mode behaviour before claiming ACP-wide coverage. First deliver live app/browser exclusion and coarse mutation ownership; narrow file claims and additional resource profiles follow the same contract.

Required verification for implementation: simultaneous requests yield exactly one exclusive grant; losing request never executes its side effect; release lets a waiter proceed; independent worktrees and isolated app environments proceed concurrently; same live UI across two worktrees blocks; different repositories using desktop input block; file/directory/symlink conflicts match; branch changes and build-copy/test consumption conflict; multi-resource requests are all-or-none; FIFO/cancellation avoid starvation; retries and reconnects are idempotent; idle follow-up does not retain old claims; crash/SIGKILL/sleep/clock changes/orphan children do not cause double ownership; corrupt snapshots and projection failures fail safely; secret-bearing events are redacted; permission modes and read-only boundaries stay intact.

Exercise two real sessions and two broker contenders in temporary environments. Run core tests, full workspace type/build checks, desktop Git tests for Git changes and the full desktop E2E suite for UI changes. Rebuild core/renderer, copy renderer, and build desktop before E2E. Visually inspect the actual waiting/release flow in the running app and retain useful screenshots under `.praxis/session-artifacts/`. Tests must not write coordination state or fixture changes into the real planning tree or a developer's live profile.

## Planning verification and limits

This research task modifies only planning documents and indexes. Parser validation checks item recognition, unique IDs, H1/type/status metadata, counts and local links; it does not validate the proposed concurrency protocol. No app was launched or automated and no build/test suite was run because this task contains no implementation. Broker IPC/election dependency, native hook coverage and platform replacement/durability details are explicit implementation feasibility work, not unresolved product choices requiring a user decision now.

## Written artifact manifest

Every plan item below meets the title (H1), explicit type, unique ID, recognized status, dependency section and canonical layout rules. The parser recognized all seven IDs exactly once.

| File under docs/ | ID | Type | Status | H1 |
| --- | --- | --- | --- | --- |
| `plans/features/fx-bf-048-agent-session-coordination/feature.md` | FX-BF-048 | Feature | Backlog | Agent session communication and resource coordination |
| `plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/story.md` | FX-BE-150 | Story | Backlog | Coordinate session activity and exclusive resources |
| `plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/tasks/task-391-coordination-contracts.md` | TASK-391 | Task | Backlog | Define coordination schema and resource conflicts |
| `plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/tasks/task-392-coordination-broker.md` | TASK-392 | Task | Backlog | Design and implement the single local broker |
| `plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/tasks/task-393-coordination-runtime.md` | TASK-393 | Task | Backlog | Gate session tools and reconcile their lifecycle |
| `plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/tasks/task-394-coordination-communication.md` | TASK-394 | Task | Backlog | Expose bounded messages and resource waiting status |
| `plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/tasks/task-395-coordination-verification.md` | TASK-395 | Task | Backlog | Prove contention, isolation and safe recovery |

Additional written documents: `research/agent-session-coordination.md` (this research); `issues/features/fx-bf-048-agent-session-coordination/feature-issues.md` (H1: FX-BF-048 issue mirrors); `issues/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/issue.md` (H1: FX-BE-150: Coordinate session activity and exclusive resources). These are outside the parsed plans tree. Updated indexes: `PLAN_MAP.md` and `issues/index.md`; added local rows only.

Parser counts: features 46 → 47; stories 142 → 143; all child items 451 → 457, including tasks 295 → 300. Local document/index links and illustrative JSON parse successfully; `git diff --check` passes. Runtime tests and screenshots are intentionally outside this planning-only task.

Hook-detail review validation: all seven existing plan items remain uniquely recognized with explicit types, H1 titles and Backlog status. Counts before/after this review are unchanged at 47 features, 143 stories and 457 child items (300 tasks). Local links, index links, JSON example and whitespace checks pass. Updated this research document, the feature, story, TASK-391–395, the story issue mirror and TASK-393 dependency row in PLAN_MAP; no new IDs or runtime/configuration changes. Builds, E2E and visual inspection remain implementation-stage verification and were not run for this documentation review.
