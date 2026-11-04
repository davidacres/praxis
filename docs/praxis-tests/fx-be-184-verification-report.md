# FX-BE-184 durable team-chat release verification report

Ticket: **PRX-S111-184 / FX-BE-184** (TASK-486, TASK-487). Feature: **FX-BF-111**. Base: `c6e81e86`.
Node:test contracts: [fx-be-184-release-proof.md](fx-be-184-release-proof.md). Playwright contracts: [catalog.json](catalog.json) (800 tests, curated flows for every new id).

**Release gate remains open:** real API continuation has no credential, the planned hand-driven dark-theme session is incomplete, and the full functional run was not green on its first attempt. Deterministic passes below do not close those requirements.

Each section below is evidence of one kind; they are not merged. A skipped test is listed as skipped, never as passed.

## Defects found and fixed by this verification

| # | Defect | Found by | Fix |
| --- | --- | --- | --- |
| F1 | Startup recovery was lazy: interrupted attempts were reconciled and queued turns resumed only when some window called `assistant:getConversation`. | `teamChatIpcRecovery.test.ts:35`, `durableTeamChat.spec.ts:288` | `teamChatServices.ts` (`recoverOnStartup`), called from `index.ts` after `registerAssistantIpc`. A profile that never activated durable chat is left untouched. |
| D1 | A late callback fenced by a newer epoch, or any storage fault inside the detached coordinator loop, escaped as an unhandled rejection and nobody was told the turn stopped. | `teamChatCrashBoundaries.test.ts:207`, `:265` | `teamChatCoordinator.ts` `processConversation`: a fenced loop drains silently; any other error is logged and published as `turn_failed` with the message. What already committed stays for startup recovery. |
| D1b | After such a fault, a later submit in the same process re-entered the loop, which stopped silently: reservation correctly refuses a second attempt while the faulted one is still `running`, but nothing told the user why their accepted turn never started. | `teamChatCrashBoundaries.test.ts:297` (fails without the fix: the halt is not re-reported; the provider call count stays 1 either way, so no double dispatch was possible) | Dispatch for that conversation halts in-process until startup recovery reconciles it under a new epoch. **Decision:** later queued turns stay `queued`. They were accepted and never ran, so failing them would discard accepted input and retrying them here would race the unknown attempt; startup recovery dispatches them in order. New commands still commit, and each one re-publishes `turn_failed` ("Restart Praxis to recover this team chat."). Reporting is wrapped so a throwing listener or logger cannot escape the detached loop. |
| D2 | Re-opening the already-open team chat from the sidebar blanked its transcript (`loadChat` cleared state that the subscription only re-reads on a new id). The first fix short-circuited on the id alone, so a chat whose first load had failed could never be re-read. | `assistant.spec.ts:590`; `durableTeamChat.spec.ts:356` (fails on the id-only short-circuit: the transcript stays empty) | `AssistantProvider.tsx` `loadChat` keeps the transcript only when the subscription has delivered a snapshot for that id; otherwise it re-subscribes (a `chatLoad` counter, since setting the same id does not re-run the effect). A chat changed by another window is already kept live by the subscription. |
| F3 | The renderer unit suite (including `conversationSubscription.test.ts`) was registered but never executed by root `test`/`test:full`. | plan analysis | root `test:renderer`, run by `test` and `test:full`; AGENTS.md updated. |
| F7 | No team-chat spec was in the smoke set, so governed runs never exercised the feature. | plan analysis | `durableTeamChat` added to `SMOKE_SPECS` (it uses no hover, mouse, drag or `toHaveScreenshot`). |

**Recorded deviation (F2, not changed):** the coordinator never projects `awaiting_approval` onto the durable attempt; the runtime session holds it. A crash during a permission prompt is therefore recovered from a dispatched `running` attempt and classified `outcome_unknown` for a tool-capable member, where the design's matrix row says `interrupted`. Both states refuse automatic replay. The safety property, that the approval is never reused by a replacement attempt, is asserted (`teamChatCrashBoundaries.test.ts:171`, `durableTeamChat.spec.ts:391`).

## AC1–AC12 → named assertions and artifacts

| AC | Assertions (file:line) | Artifacts | Result |
| --- | --- | --- | --- |
| AC1 one turn per command; ordered concurrent sends | `teamChatCoordinator.test.ts:65`, `:300`; `teamChatCrashBoundaries.test.ts:237` (3 submits → 1 turn, 1 receipt, 1 execution); `teamChatRepository.test.ts:14`, `:242` (20 interleaved writes from two instances, none lost); `durableTeamChat.spec.ts:199` (both acknowledgements lost) | — | pass |
| AC2 four attempts, two reusable sessions; isolation; no synthetic session for no-tools API | `assistant.spec.ts:975`, `:940`; `teamChatCoordinator.test.ts:445` | live CLI evidence (below) | pass (deterministic). The real CLI did **not** reuse its session: see real-provider results |
| AC3 window close/reload preserves execution; another window reconstructs | `durableTeamChat.spec.ts:13` (second window shows each message, the active member "dev: running", queue status; replies land after window one navigates away); `durableTeamChat.spec.ts:252` (process killed mid-reply, relaunch reconciles before the chat opens); `assistant.spec.ts:698` | `durable-team-chat-two-windows.png`, `durable-team-chat-queue.png`, `fx-be-184-restart-interrupted.png` | pass |
| AC4 every recovery boundary injected; no auto-repeat; no double-commit | `teamChatCrashBoundaries.test.ts:67` (accepted, no dispatch), `:83` (prepared), `:101` ×3 (dispatched text/tools/opaque), `:118` (persisted final result), `:135` (tool ran, no reply), `:154` (committed reply, ack lost), `:171` (pending approval), `:207` (late callback), `:265` (fault between reserve and complete), `:297` (a later turn after a loop fault stays queued and runs only after startup recovery); `teamChatRecovery.test.ts` (6-case matrix); `teamChatIpcRecovery.test.ts:35`; `durableTeamChat.spec.ts:252`, `:290`, `:101` | — | pass, with the F2 state-name deviation above |
| AC5 replacement reconstructs pinned decision, correction, other members; excludes queued input | `teamChatContext.test.ts:55`; `teamChatBindings.test.ts:86`; `durableTeamChat.spec.ts:427` (scripted ACP without resume: second prompt carries the first turn); `durableTeamChat.spec.ts:142` | `durable-team-chat-live-cli.json` (real CLI recalled the pinned codename after restart from a reconstructed context) | pass |
| AC6 permission/folder/provider changes invalidate bindings; never widen tools; approval stays with its attempt | `teamChatBindings.test.ts:7`, `:51`; `teamChatCrashBoundaries.test.ts:171`; `durableTeamChat.spec.ts:391` (runtime session's `teamChatExecution.attemptId` equals the durable attempt id; after SIGKILL no session is left awaiting approval and the agent gets no second prompt) | — | pass |
| AC7 migration lossless, no title merge, one writer, idempotent | `teamChatMigration.test.ts:13`, `:29` (inputs unchanged after each throw), `:46` (title-only match never merges), `:60` (synthetic session key never becomes a binding), `:71`; `teamChatActivation.test.ts:18`, `:30`, `:76`; `durableTeamChat.spec.ts:142` | — | pass. A *provable* legacy association cannot be tested: legacy chats never recorded one (see gaps) |
| AC8 one row per conversation; standalone sessions navigable | `assistant.spec.ts:590` (one team-chat row in the project feed, standalone card under General conversations, both re-open); `assistant.spec.ts:471`; `durableTeamChat.spec.ts:13` | — | pass for Easy Mode. "Both sidebar modes" no longer applies: the classic project-tree sidebar was removed on purpose (f977690f) |
| AC9 cancel/queue/retry/failure/context-required actionable across windows and restart | `durableTeamChat.spec.ts:173`, `:101`, `:254` (Retry dev enabled after restart); `teamChatCoordinator.test.ts:466`, `:552`, `:570`; `assistant.spec.ts:212` | `fx-be-184-restart-interrupted.png` | pass |
| AC10 storage errors visible; nothing accepted lost; ambiguous commits halt; corrupt files kept | `durableTeamChat.spec.ts:319` (ENOSPC alert, draft kept, transcript and file bytes unchanged, retry lands); `teamChatRepository.test.ts:27`, `:37`, `:52`, `:193` ×6 (ENOSPC/EACCES at open/write/fsync), `:219` (truncated, invalid JSON, wrong schema, duplicate id); `teamChatActivation.test.ts:76` (uncertain commit refuses writes and activation until reconciled); `teamChatCrashBoundaries.test.ts:265`, `:297`; `durableTeamChat.spec.ts:356` (a failed transcript read is shown, and re-opening the same chat re-reads it) | `fx-be-184-storage-failure.png` | pass |
| AC11 mentions, page-context detach, previews, dock/float, usage without double count | `assistant.spec.ts:405`, `:471`, `:566` (Preview then Apply; refused on Git graph page), `:79` (pin/unpin keeps the conversation); `teamChatCrashBoundaries.test.ts:237` (token totals counted once); `durableTeamChat.spec.ts:13` (50 tok) | — | pass. Dock/float keeps the conversation; it does not compare session/attempt identity (none is created by a dock switch) |
| AC12 evidence recorded separately; suites registered and executed | this report; `packages/core/package.json` (`teamChatCrashBoundaries`), `apps/praxis-desktop/main/package.json` `test:git` (`teamChatIpcRecovery`), root `test:renderer`, `SMOKE_SPECS` | catalog + supplement | partial: deterministic coverage recorded; real API and manual dark-theme evidence unresolved |

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

Run on 2026-11-04 from the repository root, in the inherited handover run (retained `/tmp/fx184/summary.log` and per-command logs inspected during recovery) (macOS, display kept awake with `caffeinate`). First-attempt results; no harness retry was used.

| Command | Result |
| --- | --- |
| `npm run build:core` | exit 0 |
| `npm run test:core` | exit 0. 1,941 tests: **1,939 passed, 0 failed, 2 skipped**. The two skips are unrelated pre-existing conditional skips (`native stdio MCP reads indexed source only with the selected provider grant`, `native all-granted bridge follows grants made and revoked while it runs`). Every team-chat suite passed, including all 14 cases of `teamChatCrashBoundaries.test.ts`. |
| `npm run check-types` | exit 0 (every workspace) |
| `npm run build:renderer` | exit 0 (only the existing chunk-size warning) |
| `npm run desktop:copy-renderer` | exit 0 |
| `npm run build:desktop` | exit 0 |
| `npm run test:desktop:git` | exit 0. **139 passed**, 0 failed, 0 skipped (includes `teamChatRepository`, `teamChatActivation`, `teamChatExecutionAdapter`, `teamChatIpcRecovery`) |
| `npm run test:renderer` | exit 0. **33 passed**, 0 failed, 0 skipped (includes `conversationSubscription.test.ts`) |
| focused e2e: `assistant.spec.ts quickSession.spec.ts durableTeamChat.spec.ts standaloneConversations.spec.ts --project=functional` | exit 1. **44 passed, 1 failed, 0 skipped**. The failure was `assistant.spec.ts:106` (floating assistant drags and resizes with the real mouse: width grew 650 px, not more than 700 px). It passed in the full suite run that followed and passed alone (5.0 s). It is pointer-dependent and outside the smoke set by design; recorded as a flake, not a regression. All 12 `durableTeamChat.spec.ts` tests passed. |
| `npm run test:praxis-contracts` | exit 0. 800 Playwright tests catalogued and linked |

## Real-provider results

`PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent e2e/durableTeamChat.live.spec.ts`: **1 passed, 1 skipped** (16.3 s).

**Real CLI: passed.** `claude-agent-acp` (Praxis provider `claude-code-cli`, read-only tools, manual permissions, temporary working directory). Evidence retained in `.praxis/session-artifacts/durable-team-chat-live-cli.json` (recorded 2026-11-04T12:26:16Z, conversation `chat-mw23bq17-louw2`, pinned codename `heron-cogr7`):

| Turn | Attempt | Coordinator epoch | Binding | Provider session | Context messages delivered |
| --- | --- | --- | --- | --- | --- |
| 1 (pin the codename) | `id-mw23bq2p-f9p14t` | `id-mw23bq1q-fnpg6s` | `id-mw23bq2q-jyvm1f` (now invalid) | `80c01ae3-d0f8-470b-811e-fc4f9b14e1d8` | 1 |
| 2 (a follow-up) | `id-mw23bt8f-nr7hhw` | `id-mw23bq1q-fnpg6s` | `id-mw23bt8g-kq4x3x` (now invalid) | `c15bc97d-3414-4a79-9282-d63787add941` | 3 |
| app restart | | | | | |
| 3 (recall the codename) | `id-mw23bxry-v24jjp` | `id-mw23bw8z-2rylsf` (new epoch) | `id-mw23bxs0-fdx4wo` (valid) | `879e1b0e-48e5-4d0b-a9f5-b2e304b9008e` | 5 |

The third reply was `heron-cogr7`: the member continued correctly after the restart. It did so by **reconstructing** the bounded context (5 messages delivered to a new session), not by resuming a provider session. The real CLI did not reuse its session even between turns 1 and 2 of the same epoch; each turn opened a new binding and invalidated the previous one. Continuation is correct, but provider-session reuse (AC2's "two reusable sessions") is proved only with the deterministic fixtures, not against the real CLI. An earlier run of the same spec (11:53Z, codename `heron-h10ko`) behaved identically.

**Real API: skipped, blocker.** No API credential is available in this environment (`PRAXIS_LIVE_API_PROVIDER` / `PRAXIS_LIVE_API_KEY` unset). The test skipped with that reason. No mock was substituted. To close it, a person with an API key runs the command above with both variables set; the spec writes `durable-team-chat-live-api.json`.

## Full-suite results

**`npm run test:desktop` (functional, 763 tests, 19.3 min): 745 passed, 4 failed, 14 skipped.** None of the four is in team-chat code, and each passed when re-run alone right after (`--retries=0`):

| Failure in the full run | Error | Alone |
| --- | --- | --- |
| `agentHub.spec.ts:88` Agent Runtime record buttons follow the app theme | `toHaveCSS` background read the previous theme's colour within 5 s | passed (7.4 s) |
| `notesPersistence.spec.ts:244` ordinary note actions never call a provider | `ChipSelect` option click timed out after 30 s | passed (6.9 s) |
| `scheduledRunEndToEnd.spec.ts:53` mixed serial/parallel schedule runs to completion | its own temp repo had one uncommitted file when Review started | passed (2 tests, 2.3 min) |
| `sessionShelf.spec.ts:262` only the revealed spine glows | glow attribute stayed `false` within 5 s | passed (8.3 s) |

Each failure passed alone, which is evidence of intermittent behavior; it does not prove that the first-run failures are unrelated to this story. The first-run full-suite gate remains failed. None of the 14 skips is in a team-chat spec: the focused team-chat run above had 0 skips, so the skips are other specs' own conditional skips.

**`npm run test:desktop:themes` (themes + theme-regressions): 47 passed, 0 failed, 0 skipped** (1.9 min).

## Visual evidence

Captured by the specs that assert each state (re-run in this pass at 12:23–12:24Z), and opened and inspected:

- `.praxis/session-artifacts/durable-team-chat-two-windows.png`: the second window shows the first question, the queued "Queued original context" turn and both Senior Dev replies, with 50 tok of usage. The sidebar row reads "team chat · 1 participant".
- `.praxis/session-artifacts/durable-team-chat-queue.png`: the queued turn and its status in the composer area.
- `.praxis/session-artifacts/fx-be-184-restart-interrupted.png`: after SIGKILL and relaunch, the turn reads "dev: interrupted" with **Retry dev** and **Stop**. No reply was replayed.
- `.praxis/session-artifacts/fx-be-184-storage-failure.png`: the ENOSPC error is shown in the panel, the draft "Lost to a full disk" is kept in the composer, and the earlier question and reply remain.

Observations, not changed here:

- The sidebar's "team chat · 0 participants" counts members who have **replied**: it reads 0 after an interrupted first turn and 1 once dev answers. That is consistent, not a defect, though "participants" could be misread as the selected members.
- The storage error shows Electron's raw prefix ("Error invoking remote method 'assistant:submitTurn': Error: ENOSPC …"). It is visible and accurate; making it friendlier is a presentation follow-up.

Not done in this pass: a separate hand-driven session in a dark theme. Dark and light palettes are covered automatically by the assistant theme × surface-pack contrast guard in `assistant.spec.ts` (passed in the focused and full runs) and the theme suites (47/47). All captures above are in the default light theme.

## Size and latency fixture

`teamChatRepository.test.ts:259`: one file holding a 10,000-message chat plus a small chat is **4,335,274 bytes**; five large-chat commits interleaved with five small-chat commits from a second instance took **83, 144, 194, 242 and 288 ms** locally (each queued behind the other writer). The whole-file JSON repository rewrites every chat on every commit, so cost grows with total stored history. This is acceptable at this size; if real profiles approach tens of MB, the follow-up is an indexed backend, as the design directs. Nothing was changed here.

## Rollback limits

Restoring the `.v1-backup` is possible only before the first durable turn is accepted (`restoreBeforeAcceptance`, `teamChatActivation.test.ts:64`). After that, repair forward. Setting `PRAXIS_DURABLE_TEAM_CHAT=0` disables activation and startup recovery (`teamChatIpcRecovery.test.ts:69`, `:83`) but does not convert durable data back.

## User-data safety

Every new test uses a `mkdtemp` profile, repository and coordination root (`launchTestApp`, `profile()` helpers); prompt logs are temp files removed in `finally`. No test points a Praxis write path at the working tree; `journey.spec.ts`'s fingerprint guard runs in the full suite. Artifacts are written only to `.praxis/session-artifacts/`, which is git-ignored.

## Handover recovery audit

The handover checkpoint `3d52716f` already contained the guarded loop reporting,
halted-conversation policy, loaded-snapshot guard and their regression tests.
This pass inspected those implementations and the retained command logs rather
than reapplying the fixes. The report now explicitly keeps the release gate open
and does not infer absence of regressions from isolated rerun passes.

Fresh recovery validation: core build, all-workspace type checks, renderer build,
renderer copy and desktop build exited 0. Core: 1,939 passed, 2 skipped, 0 failed;
main: 139 passed, 0 skipped/failed; renderer: 33 passed, 0 skipped/failed;
catalog: 800 linked tests, exit 0. Initial sandboxed runs failed on localhost
`listen EPERM`; unchanged commands were rerun with permitted access. These are
separate from the inherited full-suite and real-provider results above.

Fresh focused Electron run: **44 passed, 1 failed, 0 skipped** (2.9 min).
The failed case was keyboard queued cancellation: the queued row remained after
Enter. It passed unchanged alone (1/1, 3.6 s). The test now uses the button's
`locator.press('Enter')` instead of separate focus and page-keyboard calls;
this retains keyboard activation and all cancellation/transcript assertions
while reducing the gap between focus and input. This rerun does not erase the
first-run failure. No production change was made for this intermittent result.

Final durable-team-chat suite after the keyboard harness change: **12 passed,
0 failed, 0 skipped** (1.1 min). Final catalog validation: exit 0, 800 linked
Playwright tests. Full functional/themes and live-provider checks were not
repeated in this handover audit; their retained results above remain separate.
