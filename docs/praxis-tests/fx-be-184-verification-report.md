# FX-BE-184 durable team-chat release verification report

Ticket: **PRX-S111-184 / FX-BE-184** (TASK-486, TASK-487). Feature: **FX-BF-111**. Base: `c6e81e86`.
Node:test contracts: [fx-be-184-release-proof.md](fx-be-184-release-proof.md). Playwright contracts: [catalog.json](catalog.json) (799 tests, curated flows for every new id).

Each section below is evidence of one kind; they are not merged. A skipped test is listed as skipped, never as passed.

## Defects found and fixed by this verification

| # | Defect | Found by | Fix |
| --- | --- | --- | --- |
| F1 | Startup recovery was lazy: interrupted attempts were reconciled and queued turns resumed only when some window called `assistant:getConversation`. | `teamChatIpcRecovery.test.ts:35`, `durableTeamChat.spec.ts:290` | `teamChatServices.ts` (`recoverOnStartup`), called from `index.ts` after `registerAssistantIpc`. A profile that never activated durable chat is left untouched. |
| D1 | A late callback fenced by a newer epoch, or any storage fault inside the detached coordinator loop, escaped as an unhandled rejection and nobody was told the turn stopped. | `teamChatCrashBoundaries.test.ts:207`, `:265` | `teamChatCoordinator.ts` `processConversation`: a fenced loop drains silently; any other error is logged and published as `turn_failed` with the message. What already committed stays for startup recovery. |
| D2 | Re-opening the already-open team chat from the sidebar blanked its transcript (`loadChat` cleared state that the subscription only re-reads on a new id). | `assistant.spec.ts:590` (failed before, passes after) | `AssistantProvider.tsx` `loadChat` keeps the transcript when the id is unchanged. |
| F3 | The renderer unit suite (including `conversationSubscription.test.ts`) was registered but never executed by root `test`/`test:full`. | plan analysis | root `test:renderer`, run by `test` and `test:full`; AGENTS.md updated. |
| F7 | No team-chat spec was in the smoke set, so governed runs never exercised the feature. | plan analysis | `durableTeamChat` added to `SMOKE_SPECS` (it uses no hover, mouse, drag or `toHaveScreenshot`). |

**Recorded deviation (F2, not changed):** the coordinator never projects `awaiting_approval` onto the durable attempt; the runtime session holds it. A crash during a permission prompt is therefore recovered from a dispatched `running` attempt and classified `outcome_unknown` for a tool-capable member, where the design's matrix row says `interrupted`. Both states refuse automatic replay. The safety property, that the approval is never reused by a replacement attempt, is asserted (`teamChatCrashBoundaries.test.ts:171`, `durableTeamChat.spec.ts:358`).

## AC1–AC12 → named assertions and artifacts

| AC | Assertions (file:line) | Artifacts | Result |
| --- | --- | --- | --- |
| AC1 one turn per command; ordered concurrent sends | `teamChatCoordinator.test.ts:65`, `:300`; `teamChatCrashBoundaries.test.ts:237` (3 submits → 1 turn, 1 receipt, 1 execution); `teamChatRepository.test.ts:14`, `:242` (20 interleaved writes from two instances, none lost); `durableTeamChat.spec.ts:201` (both acknowledgements lost) | — | pass |
| AC2 four attempts, two reusable sessions; isolation; no synthetic session for no-tools API | `assistant.spec.ts:975`, `:940`; `teamChatCoordinator.test.ts:445` | live CLI evidence (below) | pass (deterministic). The real CLI did **not** reuse its session: see real-provider results |
| AC3 window close/reload preserves execution; another window reconstructs | `durableTeamChat.spec.ts:13` (second window shows each message, the active member "dev: running", queue status; replies land after window one navigates away); `durableTeamChat.spec.ts:254` (process killed mid-reply, relaunch reconciles before the chat opens); `assistant.spec.ts:698` | `durable-team-chat-two-windows.png`, `durable-team-chat-queue.png`, `fx-be-184-restart-interrupted.png` | pass |
| AC4 every recovery boundary injected; no auto-repeat; no double-commit | `teamChatCrashBoundaries.test.ts:67` (accepted, no dispatch), `:83` (prepared), `:101` ×3 (dispatched text/tools/opaque), `:118` (persisted final result), `:135` (tool ran, no reply), `:154` (committed reply, ack lost), `:171` (pending approval), `:207` (late callback), `:265` (fault between reserve and complete); `teamChatRecovery.test.ts` (6-case matrix); `teamChatIpcRecovery.test.ts:35`; `durableTeamChat.spec.ts:254`, `:290`, `:101` | — | pass, with the F2 state-name deviation above |
| AC5 replacement reconstructs pinned decision, correction, other members; excludes queued input | `teamChatContext.test.ts:55`; `teamChatBindings.test.ts:86`; `durableTeamChat.spec.ts:394` (scripted ACP without resume: second prompt carries the first turn); `durableTeamChat.spec.ts:142` | `durable-team-chat-live-cli.json` (real CLI recalled the pinned codename after restart from a reconstructed context) | pass |
| AC6 permission/folder/provider changes invalidate bindings; never widen tools; approval stays with its attempt | `teamChatBindings.test.ts:7`, `:51`; `teamChatCrashBoundaries.test.ts:171`; `durableTeamChat.spec.ts:358` (runtime session's `teamChatExecution.attemptId` equals the durable attempt id; after SIGKILL no session is left awaiting approval and the agent gets no second prompt) | — | pass |
| AC7 migration lossless, no title merge, one writer, idempotent | `teamChatMigration.test.ts:13`, `:29` (inputs unchanged after each throw), `:46` (title-only match never merges), `:60` (synthetic session key never becomes a binding), `:71`; `teamChatActivation.test.ts:18`, `:30`, `:76`; `durableTeamChat.spec.ts:142` | — | pass. A *provable* legacy association cannot be tested: legacy chats never recorded one (see gaps) |
| AC8 one row per conversation; standalone sessions navigable | `assistant.spec.ts:590` (one team-chat row in the project feed, standalone card under General conversations, both re-open); `assistant.spec.ts:471`; `durableTeamChat.spec.ts:13` | — | pass for Easy Mode. "Both sidebar modes" no longer applies: the classic project-tree sidebar was removed on purpose (f977690f) |
| AC9 cancel/queue/retry/failure/context-required actionable across windows and restart | `durableTeamChat.spec.ts:173`, `:101`, `:254` (Retry dev enabled after restart); `teamChatCoordinator.test.ts:466`, `:552`, `:570`; `assistant.spec.ts:212` | `fx-be-184-restart-interrupted.png` | pass |
| AC10 storage errors visible; nothing accepted lost; ambiguous commits halt; corrupt files kept | `durableTeamChat.spec.ts:321` (ENOSPC alert, draft kept, transcript and file bytes unchanged, retry lands); `teamChatRepository.test.ts:27`, `:37`, `:52`, `:193` ×6 (ENOSPC/EACCES at open/write/fsync), `:219` (truncated, invalid JSON, wrong schema, duplicate id); `teamChatActivation.test.ts:76` (uncertain commit refuses writes and activation until reconciled); `teamChatCrashBoundaries.test.ts:265` | `fx-be-184-storage-failure.png` | pass |
| AC11 mentions, page-context detach, previews, dock/float, usage without double count | `assistant.spec.ts:405`, `:471`, `:566` (Preview then Apply; refused on Git graph page), `:79` (pin/unpin keeps the conversation); `teamChatCrashBoundaries.test.ts:237` (token totals counted once); `durableTeamChat.spec.ts:13` (50 tok) | — | pass. Dock/float keeps the conversation; it does not compare session/attempt identity (none is created by a dock switch) |
| AC12 evidence recorded separately; suites registered and executed | this report; `packages/core/package.json` (`teamChatCrashBoundaries`), `apps/praxis-desktop/main/package.json` `test:git` (`teamChatIpcRecovery`), root `test:renderer`, `SMOKE_SPECS` | catalog + supplement | pass |

## Gaps recorded by earlier stages — disposition

- **G1** second window active member: asserted (`durableTeamChat.spec.ts:13`). Dock/float execution identity: a dock switch creates no execution, so there is no identity to compare; the conversation is kept (`assistant.spec.ts:79`).
- **G2** standalone chat beside the team-chat row: `assistant.spec.ts:590`.
- **G3** captured page context of a queued turn: covered at core level by `teamChatCoordinator.test.ts:673` (original page identity survives completion); not asserted for a *queued* turn through the UI.
- **G4** Preview then Apply, refusal on an incompatible page: `assistant.spec.ts:566`.
- **G5** title-only match: `teamChatMigration.test.ts:46`. Provable association: not testable, legacy records carry no runtime association (`teamChatMigration.test.ts:60` proves the synthetic key is not treated as one).
- **G6** overstated titles: PT-4485239A20 (`teamChatActivation.test.ts:76`) now proves the uncertain-commit fence; PT-A75870DFCA (`teamChatMigration.test.ts:29`) now re-checks each input; PT-592434CA9B (`durableTeamChat.spec.ts:13`) still does not assert queued attachments (its flow says so).
- **G7** binding invalidation, token totals, atomicity under fault: `teamChatBindings.test.ts:51`, `teamChatCrashBoundaries.test.ts:237`, `:265`.
- **G8** dispatch disabled after activation failure: `teamChatIpcRecovery.test.ts:83`.

## Deterministic results

<!-- filled from the run logs -->

## Real-provider results

<!-- filled from the live run -->

## Full-suite results

<!-- filled from the full functional and theme runs -->

## Visual evidence

<!-- filled after manual inspection -->

## Size and latency fixture

`teamChatRepository.test.ts:259`: one file holding a 10,000-message chat plus a small chat is **4,335,274 bytes**; five large-chat commits interleaved with five small-chat commits from a second instance took **83, 144, 194, 242 and 288 ms** locally (each queued behind the other writer). The whole-file JSON repository rewrites every chat on every commit, so cost grows with total stored history. This is acceptable at this size; if real profiles approach tens of MB, the follow-up is an indexed backend, as the design directs. Nothing was changed here.

## Rollback limits

Restoring the `.v1-backup` is possible only before the first durable turn is accepted (`restoreBeforeAcceptance`, `teamChatActivation.test.ts:64`). After that, repair forward. Setting `PRAXIS_DURABLE_TEAM_CHAT=0` disables activation and startup recovery (`teamChatIpcRecovery.test.ts:69`, `:83`) but does not convert durable data back.

## User-data safety

Every new test uses a `mkdtemp` profile, repository and coordination root (`launchTestApp`, `profile()` helpers); prompt logs are temp files removed in `finally`. No test points a Praxis write path at the working tree; `journey.spec.ts`'s fingerprint guard runs in the full suite. Artifacts are written only to `.praxis/session-artifacts/`, which is git-ignored.
