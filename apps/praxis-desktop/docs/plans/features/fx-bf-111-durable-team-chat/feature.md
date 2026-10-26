---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Feature
**Priority:** High
id: FX-BF-111
type: Feature
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
---

# FX-BF-111: Durable team-chat conversations

## Outcome

One durable team conversation remains correct across multiple replies, window closure, provider replacement and process interruption. Provider sessions are reusable resources; every member reply has a separate auditable execution attempt. This supersedes the renderer-owned scheduling and implicit linkage in FX-BF-050 without reopening or rewriting its historical completion records.

## Scope and boundaries

Implement core contracts/coordinator/context/recovery, Electron persistence and runtime adapters, typed IPC, assistant UI subscriptions, sidebar classification and legacy migration. Share existing provider, permission, usage and coordination mechanisms. Standalone sessions and bounded two-AI review retain their own scheduling policies; do not migrate those workflows in this feature. Parallel team replies, distributed coordination, cloud sync and automatic autonomous debate are excluded. No new dependency is required by this design.

## Current implementation evidence

Paths are relative to the monorepo root; inspected 2026-10-26 in the active checkout including its uncommitted reuse fix.

| Seam | Observed behavior | Implementation destination |
| --- | --- | --- |
| `apps/praxis-desktop/renderer/src/assistant/AssistantProvider.tsx` | `send` schedules members and `persist` replaces transcripts | Command/subscription client; local draft and page registration only |
| `packages/core/src/ai/assistant/teamChatStore.ts` | CRUD on `teamChats`, whole-message replacement | Versioned repository facade with transactions |
| `apps/praxis-desktop/main/src/main/assistantIpc.ts` | Synthetic ASSISTANT keys, hashed configuration, diagnostic checkpoints, process-local active set | Validated command adapter and coordinator singleton |
| `packages/core/src/ai/assistant/assistantEngine.ts` | Fixed history count and per-message character clipping | Pure persona/output helpers plus explicit context builder |
| `packages/core/src/ai/assistant/assistantTypes.ts` and `packages/core/src/host/ipcContracts.ts` | Transcript and turn request contracts | Durable entities and command/event contracts |
| `apps/praxis-desktop/main/src/main/adapters/jsonKeyValueStore.ts` | Mutable cached state, queued JSON writes; load errors become empty data | Dedicated chat adapter with strict load and commit semantics; unrelated stores unchanged |
| `apps/praxis-desktop/main/src/main/agentSessionLauncher.ts`, `packages/core/src/ai/aiSessionManager.ts`, `packages/core/src/ai/agentTypes.ts` | Existing launch/continue, session events and permissions | Injected execution adapter and typed ownership metadata |
| `apps/praxis-desktop/main/src/preload/index.ts`, `renderer/src/ai/sessionNav.ts`, `renderer/src/app/App.tsx`, `renderer/src/app/Sidebar.tsx`, `renderer/src/components/sidebar/EasyModeSidebar.tsx` (renderer paths under desktop) | Bridge and navigation consumers | Revisioned subscriptions and shared ownership classification |

The code index returned external-only TeamChatStore declarations; these findings were confirmed directly in source. Existing dirty implementation/test files are input evidence, not changes delivered by this plan.

## Concrete data model

Keep `TeamChatRecord.id` as the stable conversation ID and add schema version 2. Store one authoritative profile-local document with a monotonically increasing store revision and conversation revisions. Existing messages remain the transcript; no independent second transcript database.

| Entity | Required data and invariant |
| --- | --- |
| Conversation | ID, optional project/issue association, title, dates, revision, participant configurations, ordered messages, turns, bindings, summaries, command receipts. Folderless conversations are durable too; never substitute the application cwd. |
| Message | Existing ID/role/text/time/actions/choices plus monotonic sequence, turn ID, participant ID where applicable, attachment references and captured page context. Final transcript messages are immutable; corrections are new messages. |
| Participant | Stable ID and role, versioned persona instructions, effective defaults. For this feature each role has one seat per conversation. Removing a seat affects future turns, retaining history. |
| Turn | ID, client command ID and payload digest, user-message ID, captured roster/order/runtime/context, accepted sequence, state, participant step results. The plan is immutable once accepted. |
| Attempt | ID, turn/participant IDs, ordinal, coordinator epoch, state, optional binding/session ID, prepared context receipt, dispatch intent, timestamps, error, final result, usage and tool evidence references. Retry creates a new attempt. |
| Binding | ID, conversation/participant IDs, provider runtime/native session IDs if supported, resolved compatibility digest, delivered-message boundary and native-output coverage, valid/invalid status. An API request need not have a persistent binding. |
| Summary | ID/version, source sequence range and digest, text, creation attempt/provider, supersedes ID. User-pinned decisions reference original messages and remain separate from generated summaries. |
| Command receipt | Command ID, canonical payload digest, outcome and resulting turn/revision. Retain for the conversation lifetime, including terminal turns. |

Add optional typed `teamChatExecution` ownership to runtime session records. The conversation binding/attempt relation is authoritative; the runtime metadata is a projection for navigation, usage and diagnostics and can be reconciled. It must not require a transaction spanning two existing stores. A session's current attempt pointer is not a substitute for the conversation's attempt history.

## Persistence and commit boundaries

Use the existing profile-local `team-chats.json` location with a versioned envelope. Implement a chat-specific repository adapter rather than relying on generic `KeyValueStore.update` as a transactional guarantee. One main instance per profile owns writes (retain the application's single-instance boundary). Serialize the entire read/validate/clone/mutate/write/publish operation across all chats because the file is shared. Renderer callers never receive mutable repository objects.

Commit to a unique temp file in the same directory, flush and close it, atomically rename it, and flush the directory where the platform supports this. Publish the in-memory clone, acknowledge and broadcast only after commit. Pre-rename errors retain the previous committed state. A post-rename flush/error is an uncertain commit: stop dispatch, reload and reconcile its command receipt before accepting more writes. Do not claim arbitrary hardware power-loss durability on platforms that cannot provide it. Read errors/corruption fail visibly; never silently initialize over an existing file.

Atomic mutations: (1) accept user message + response plan + command receipt; (2) reserve attempt + context receipt + dispatch intent; (3) append final reply + terminal attempt + member progress + context coverage; (4) cancellation/recovery decision + affected state. Persist final provider output correlated by attempt before reporting success; runtime final evidence can be reconciled if it lands before conversation commit. Stream deltas are presentation only until committed: a restart may lose an unfinished text tail, which remains explicitly interrupted rather than becoming a fabricated final reply. Tool audit details may live in the existing runtime event store with stable references; uncertain missing evidence prevents replay.

Attachments must be copied into immutable profile-owned storage before acceptance and referenced by digest/media type/size. Preserve existing limits and provider capabilities; reject unsupported attachments explicitly. Unreferenced staged files can be cleaned only after confirming no accepted turn references them. Archive/deletion must fence active execution and settle cancellation before removal; deletion must never cause an automatic replay. Retention cleanup cannot delete live attempt evidence.

## Commands and event delivery

`submitTurn({conversationId, commandId, text, selectedParticipantIds, context, attachmentRefs, runtimeOptions})` returns `{turnId, revision, state}` after durable acceptance. Create a conversation before first submission, including projectless chats. Main resolves effective settings, validates project/folder/trust and permissions, parses mentions, and freezes the response plan. The renderer creates one command UUID per send and reuses it on transport retry. A repeated ID with identical canonical payload returns the original result; reuse with different content is an error.

Add `getConversation`, revisioned conversation subscriptions, `cancelTurn`, queued-turn cancellation, `retryParticipant`, `resolveAttempt`, and pin/unpin-decision operations. All mutations carry command IDs; state-sensitive mutations also carry expected revision and target attempt ID. Return a conflict with fresh state for stale commands. Subscribe before loading a snapshot, buffer events, then discard revisions covered by the snapshot. A gap triggers reload. Broadcast summaries for lists separately from transcript deltas; do not send complete history on every token. Reuse the existing sessionChangeStream when consuming runtime sessions; do not subscribe directly to raw session deltas in a new component.

## Scheduling and state transitions

One active turn per conversation; unrelated conversations can run subject to existing resource coordination. A submitted turn enters `queued`; FIFO activation changes it to `running`. Within a turn, use selected roles in dev, qa, security, product, lead order. Explicit @mention overrides the roster; an empty roster defaults to lead. The lead synthesises only when selected. Preserve the UI's existing initial selection. No extra hidden AI calls are added except explicit bounded context summarization.

Turn states: `queued -> running -> completed`; running can enter `awaiting_approval`, `context_required`, `failed`, `interrupted`, `outcome_unknown` or `cancelling`. Verified continuation/retry returns the same turn to running through a new attempt where necessary. Cancellation ends as `cancelled` only once the active runtime has stopped or been reconciled. Attempts use `prepared`, `dispatching`, `running`, `awaiting_approval`, `completed`, `failed`, `interrupted`, `outcome_unknown`, `cancelled`; terminal attempts are immutable. Replies from completed predecessors remain visible on any failure.

Failure, context_required, interruption and unknown outcome pause the conversation queue. Explicit successful recovery resumes it. Stop cancels remaining members and queued turns in that conversation, preserving their user messages with cancelled status. Cancelling an individual queued turn leaves the active turn alone. Retry preserves completed members, creates a new attempt for the target and resumes successors; there is no automatic hidden retry of paid provider calls. A timeout records an interruption/cancellation request, never proves a tool did not run. Use existing runtime timeout controls rather than introducing a second conflicting timer policy.

## Provider compatibility and context protocol

Reuse requires matching conversation + participant + effective provider identity/account/endpoint + model + reasoning settings + instruction version + canonical working directory + tool/permission policy + execution mode. Store hashes/references, never credentials. Revalidate current trust and policy every dispatch. For the first release, keep one current binding per participant; changing compatibility invalidates the old binding and switching back reconstructs a fresh one. This deliberately replaces the interim cache of all historical configurations and avoids resurrecting stale access or context.

The adapter declares native resume, text-only reconstruction, cancellation and reliable result/tool-status capabilities from the existing runtime implementation. Verify installed ACP capabilities during implementation; never assume every provider supports load/resume or that a transport acknowledgement proves execution completion. No-tools completions use the ordinary chat/provider abstraction, not a fictitious ticket review. Tool-enabled members reuse existing agent execution, sandbox, trust, approval and resource coordination gates.

Build a context view bounded at this turn's accepted user message plus earlier completed members of this turn. Later queued submissions are excluded even though already stored. Use provider/model context limits where available and a documented configurable conservative fallback otherwise; reserve output and tool budget before prompt construction and record estimation method. Include versioned instructions, current user input, captured context, pinned decisions, a summary of older messages and recent verbatim messages. Preserve source transcript in full. Attachment capability/size costs count toward the budget. Do not silently clip a user decision or the current request.

On native resume, send only missing shared messages, excluding the member's own output already present in its native history; track explicit covered IDs/ranges, not a single unqualified latest sequence. Commit the receipt only with confirmed completion. If prompt acceptance is uncertain, invalidate the binding and enter recovery. On reconstruction, build the complete bounded context once. A user-pinned decision remains verbatim with a source reference; later corrections are included and supersede earlier decisions explicitly. Generated summaries are fallible, versioned aids, never authoritative replacements for source history. Record source range/digest and invalidate summaries on migrated/corrected source changes. Summarization uses a no-tools attempt with usage attribution; failure or an over-budget mandatory context yields `context_required`, offering a smaller scope or explicit context selection. Never silently proceed without required history.

## Restart and external-action recovery matrix

| Durable evidence at interruption | Required recovery |
| --- | --- |
| Accepted turn, no dispatch intent | Eligible to schedule after startup reconciliation and policy validation |
| Prepared context but no dispatch intent | Safe to prepare again; no provider invocation was authorized |
| Dispatch intent, no reliable acceptance/result | Mark interrupted for verified text-only capability; tool-capable or opaque runtime becomes outcome_unknown |
| Provider final result reliably persisted for this attempt | Import result atomically once and continue pending members |
| Tool may have succeeded, final reply missing | outcome_unknown; reconcile read-only external/runtime evidence or obtain an explicit informed resolution; never automatic replay |
| Final reply committed, UI acknowledgement lost | Return stored result and replay display events only |
| Pending permission request | Reattach only to a verified live request; otherwise mark interrupted and never reuse its approval for a replacement attempt |

On startup, establish a new coordinator epoch, reconcile running attempts before dispatching queued work, and fence stale callbacks. Read-only reconciliation can confirm a result without executing the action again. Resolve unknown outcome with recorded evidence (confirmed complete with recovered result, confirmed not executed and safe retry, or user-authorized retry acknowledging duplication risk); otherwise remain blocked or cancel remaining work. Native tool calls may bypass a local per-tool journal; lack of observable evidence increases uncertainty rather than implying safety. Exactly-once external side effects are not promised.

## Migration and rollout

Deliver as a new feature depending on the existing assistant implementation, not a rewrite of historical plan cards. Stage the new writer behind an internal activation switch until its migration and recovery tests pass; no dual-write period. At cutover wait for legacy executions to settle, stop accepting legacy commands, snapshot the original store to a versioned backup, validate it and write schema v2 atomically. The migration and new writer share the same profile lock. Legacy `saveChat` is rejected once v2 activates; do not allow a stale renderer to replace its transcript.

Preserve IDs, titles, projects, timestamps, order, role, text, errors, actions and choices. Assign deterministic sequence and legacy turn groups from existing user-message boundaries; orphan assistant messages remain imported history with explicit unknown provenance. Never invent successful attempts or tool results for old messages. Import typed runtime links only where the chat ID/persona/configuration association is provable from existing records; incomplete/ambiguous bindings remain legacy diagnostics and the next turn uses a fresh binding. Titles alone are never identity evidence. Preserve old runtime records and usage; a narrow existing legacy classifier hides known internal executions, while all new navigation uses typed ownership.

Migration reruns are no-ops after version validation. Corrupt data or backup failure blocks cutover without overwriting the source. Before any v2 write, rollback can restore the backup. After v2 accepts turns, rollback to an old writer would lose new data and is forbidden without a separately reviewed export/conversion; prefer forward repair and retain both backup and v2 data. Existing unaffected standalone sessions remain readable throughout. FX-BF-110 sidebar work may consume this identity contract but is not a prerequisite for this feature; preserve project association APIs and avoid redesigning drag/grouping here.

## Feature acceptance criteria

- AC1: Repeated submit after acknowledgement loss creates one user message, one turn and one response plan; concurrent distinct sends remain ordered without lost writes.
- AC2: Two selected members across two compatible tool turns produce four attempts and two reusable provider sessions; new chats remain isolated and no-tools API use needs no synthetic session.
- AC3: Closing/reloading the initiating window preserves accepted execution; another window reconstructs the same transcript and progress from durable state.
- AC4: Every recovery-matrix boundary has an injected-failure assertion; unknown external outcomes never auto-repeat and late events never double-commit.
- AC5: Provider/session replacement reconstructs bounded context including an early pinned decision, subsequent correction and other members' replies, excluding queued future input.
- AC6: Permission/folder/provider changes invalidate incompatible bindings and never widen tool access; pending approval and resource ownership remain attached to the correct attempt.
- AC7: Migration preserves all existing chat content and known ownership without merging by title; activation has one writer and repeat migration is idempotent.
- AC8: Both sidebar modes show one row per team conversation on startup and live updates, while genuine standalone sessions remain navigable.
- AC9: Cancel, queue, retry, failure and context-required states remain actionable and consistent across windows/restart; completed replies are retained.
- AC10: Storage errors are visible, no accepted state disappears after a pre-rename failure, ambiguous commits halt dispatch, and corrupt files are not reset.
- AC11: Existing mentions, page-context detach, action previews, dock/float and reported usage remain correct with no double-counted cost.
- AC12: Deterministic, real-provider, full functional and visual release evidence is recorded separately; all new suites are actually registered and executed.

## Validation and release gates

Commands below run from the monorepo root during implementation, not during plan authoring:

```sh
npm run build:core
npm run test:core
npm run check-types
npm run build:renderer
npm run desktop:copy-renderer
npm run build:desktop
npm run test:desktop:git
npm run test:e2e --workspace=@praxis/desktop-main -- assistant.spec.ts quickSession.spec.ts --project=functional
npm run test:desktop
npm run test:desktop:themes
node apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs --write
npm run test:praxis-contracts
```

Register new core tests in `packages/core/package.json` (its list is explicit) and main tests in the existing appropriate unit runner. Extend assistant.spec.ts and existing scripted ACP/mock API fixtures. Map AC1/AC10 to repository/IPC suites; AC2/AC5/AC6 to adapter/context suites; AC3/AC4/AC9 to coordinator fault injection and Electron restart; AC7 to migration fixtures; AC8/AC11 to assistant/sidebar E2E; AC12 to the final evidence report. Add focused source tests as needed, but test actual file persistence and provider-wire paths too. Preserve failure attempts without harness retries masking flakiness. Catalog generation must retain unrelated concurrent changes and disclose pre-existing drift.

Manually verify the built renderer in Classic and Easy Mode, floating/docked, second window, queue/cancel/retry, approval and uncertain-result recovery. Retain useful screenshots in `.praxis/session-artifacts/`; inspect actual and diff before any snapshot acceptance. Opt-in real API and CLI checks require configured credentials and may incur ordinary provider usage; do not call scripted fixtures real-AI proof. No runtime build or E2E pass is claimed by this plan.

## Readiness and implementation order

Ready to start TASK-476; no unresolved architectural choice blocks it. Implement tasks in listed dependency order; each downstream task becomes runnable when its predecessors pass. Core changes belong in the monorepo `packages/core`, with desktop changes in this checkout; execution must respect filesystem permissions when work extends beyond the desktop writable root. Preserve existing WIP and review current diffs before editing. Existing fixes remain until their replacement passes equivalent regression tests. Do not publish, delete user data or revert unrelated changes as part of this plan.

## Risks and mitigations

JSON snapshots rewrite history on mutation: avoid durable writes on every token and add a size/latency fixture using a 10,000-message chat plus concurrent chat mutations; record measured cost before release. If unacceptable, retain the repository contract and propose an indexed backend in a separately reviewed follow-up; do not quietly change storage during implementation. Native-session acknowledgements and tool evidence vary: explicit capability checks and conservative unknown-outcome states are mandatory. Summaries can be wrong: pinning and source provenance preserve a recoverable authoritative history. Existing uncommitted fixes and unrelated suite failures require scoped diffs and honest evidence, not a blanket clean-suite claim.

## Close when

All six stories and twelve tasks meet their acceptance criteria, AC1–AC12 have linked evidence, migrations pass against copied legacy fixtures, runtime/UI checks are recorded, and no feature acceptance blocker remains. Implementation completion, focused test success, full-suite success and real-provider proof must be reported independently. Update plan/issue statuses only with supporting evidence.

## Story map

| ID | Story | Depends on |
| --- | --- | --- |
| [FX-BE-179](stories/fx-be-179-durable-conversation-store/story.md) | Durable conversation contracts and atomic storage | None |
| [FX-BE-180](stories/fx-be-180-main-owned-coordinator/story.md) | Main-owned turn scheduling and command delivery | FX-BE-179 |
| [FX-BE-181](stories/fx-be-181-provider-binding-and-context/story.md) | Explicit provider bindings and bounded context delivery | FX-BE-180 |
| [FX-BE-182](stories/fx-be-182-interruption-and-recovery/story.md) | Interruption, cancellation, and tool-outcome recovery | FX-BE-181 |
| [FX-BE-183](stories/fx-be-183-renderer-and-migration/story.md) | Renderer subscription, single navigation entry, and legacy migration | FX-BE-182 |
| [FX-BE-184](stories/fx-be-184-release-proof/story.md) | Durable team-chat release verification | FX-BE-183 |

## Dependencies

None outstanding for TASK-476. Existing FX-BF-050 assistant and provider/session infrastructure are the implementation foundation. FX-BF-110 is a related consumer, not a blocking dependency.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments



## Plan validation evidence

[Readiness report and complete file inventory](../../../planning-validation/fx-bf-111-durable-team-chat.md). This proves plan parsing and linkage only; implementation verification remains pending.
