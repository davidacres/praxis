# FX-BE-184 release-proof node:test contracts

Runner: **node:test**. These **30 supplemental source contracts, representing 38 runtime cases** (TASK-486 added three source contracts and four runtime cases; see [TASK-486 failure-matrix additions](#task-486-failure-matrix-additions)) (two of them existing tests strengthened here) cover crash boundaries, provider context and bindings, migration, persistence faults, activation and startup recovery. They sit outside the Playwright-only generator. IDs use SHA1(file + newline + exact title), the same rule as the catalog; two titles are template literals and stand for their parameterized cases. The two strengthened contracts retain their earlier ids; repeated documentation of those identities in older supplements is superseded here, not counted again. No id collides with the Playwright catalog.

### PT-C2406CA182

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:67](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L67).
Title: **crash after acceptance with no dispatch intent schedules the turn exactly once after startup**.

**Given** a committed snapshot taken right after durable acceptance, with no attempt.
**When** a fresh coordinator with a new epoch initializes over those bytes, and a second restart follows completion.
**Then** the provider is invoked exactly once under the new epoch, one reply lands, and the second restart dispatches nothing.

### PT-2B2156B602

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:83](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L83).
Title: **crash with prepared context but no dispatch intent re-prepares without invoking the provider before reconciliation**.

**Given** a committed snapshot whose attempt is prepared and has no dispatch intent.
**When** a new coordinator initializes, then the user retries the member.
**Then** startup marks attempt and turn interrupted without dispatch; the retry runs once as ordinal 2 with its own prepared prompt.

### PT-E4314C935F

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:101](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L101).
Title: **crash after dispatch intent marks text-only attempts interrupted and tool-capable or opaque attempts outcome_unknown: ${capability}**.

**Given** a dispatched attempt whose runtime identity is text-only, tool-capable or unrecorded (three cases from one template title).
**When** a new coordinator initializes.
**Then** text-only becomes interrupted and tool-capable or opaque becomes outcome_unknown, with a reconciliation record from the new epoch and no provider call.

### PT-56512B61AB

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:118](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L118).
Title: **a persisted final result for the attempt imports once and continues pending members**.

**Given** a dev+lead turn crashed after dev's final_result evidence committed but before its reply message.
**When** a new coordinator initializes.
**Then** dev's reply is imported once with its usage and usage reference, and only lead executes.

### PT-CB28B7FDBC

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:135](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L135).
Title: **a tool that may have run with no final reply stays outcome_unknown and is never replayed automatically**.

**Given** an accepted attempt with tool_activity evidence and no result.
**When** two independent restarts initialize over it and the caller tries retryParticipant and an unacknowledged resolveAttempt retry.
**Then** the attempt stays outcome_unknown, both retries are refused and the provider is never called.

### PT-9565811CC8

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:154](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L154).
Title: **a committed final reply whose acknowledgement was lost replays display events only**.

**Given** a snapshot with the turn completed.
**When** a new coordinator initializes and the renderer resubmits the same command.
**Then** the original turn id and completed state are returned, no turn_accepted update fires, there is one turn and one reply, and the provider is not called.

### PT-FB22769CA1

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:171](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L171).
Title: **a pending approval at crash is never reused by the replacement attempt**.

**Given** a running full-tools manual-permission attempt, in the shape files written before TASK-483 hold and with the awaiting_approval projection production records since TASK-483.
**When** a new coordinator initializes and the user retries with reconciliation evidence and the duplicate-risk acknowledgement.
**Then** the recovered attempt is exactly outcome_unknown because a pending prompt cannot exclude earlier tool activity (explicit discrepancy with the matrix's interrupted row); the replacement is ordinal 2 with permissionMode manual, no autoApprovePermissions and no carried evidence.

### PT-0B76197FF4

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:207](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L207).
Title: **late callbacks from a previous epoch never double-commit**.

**Given** an old coordinator whose execute is still pending on shared bytes.
**When** a replacement coordinator initializes and then the old execute resolves.
**Then** no reply is committed, the turns are unchanged from the fenced snapshot, the replacement never dispatches and there is no unhandled rejection.

### PT-112EE75C77

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:237](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L237).
Title: **duplicate runtime events and a duplicate submit command converge to one turn and one usage reference**.

**Given** an adapter that signals acceptance three times and reports duplicated usage and tool references.
**When** one command is submitted three times, two concurrently.
**Then** one turn, one receipt, one execution, one reply; usage and tool references are deduplicated and token totals count once; a different payload under the same id is a payload conflict.

### PT-7BDEE6CD19

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:265](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L265).
Title: **a fault between reserve and complete leaves the snapshot at the prior committed revision**.

**Given** a repository that refuses the commit that completes the attempt.
**When** the turn runs, then a new coordinator initializes over the bytes.
**Then** the snapshot equals the last committed one (final_result evidence, no reply), subscribers get turn_failed with the fault and there is no unhandled rejection; after restart the result imports once and the provider ran once in total.

### PT-E9377A7326

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:297](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L297).
Title: **after a loop fault, later queued turns stay queued and never re-dispatch the unknown attempt until startup recovery**.

**Given** a repository that refuses the commit completing the first attempt, and a subscriber that throws on `turn_failed`.
**When** storage recovers and the user submits a second turn in the same process, then a new coordinator initializes over the bytes.
**Then** the provider is not called again, the faulted turn stays `running`, the second turn stays `queued` (neither failed nor dispatched) and the halt is reported again; after restart the faulted turn is reconciled without replay and the queued turn completes.

### PT-56DCDF45E2

Automation: **node:test**, [teamChatContext.test.ts:55](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L55).
Title: **provider replacement reconstructs an early pinned decision, its later correction and other members' replies, excluding queued future input**.

**Given** a pinned decision, a pinned correction superseding it, a QA reply, the current input and a queued future input; the old provider's binding had delivered history.
**When** the binding is resolved for a different provider runtime and context is prepared with and without native resume.
**Then** the old binding is invalid, the new one has delivered nothing, and both prompts carry the decision, correction, supersedes record and QA reply but not the queued input.

### PT-33D92B9873

Automation: **node:test**, [teamChatBindings.test.ts:51](../../packages/core/src/ai/assistant/teamChatBindings.test.ts#L51).
Title: **folder, permission-mode and provider changes each invalidate the binding and never widen tool mode**.

**Given** a lead member whose binding is derived from the turn's captured options.
**When** a second turn changes folder, permission mode, provider or tool mode (four runs).
**Then** each change leaves two bindings (old invalid, new valid and used by the attempt), the new binding received the earlier turn by reconstruction, tool mode is never broader than captured and no autoApprovePermissions appears.

### PT-1AF80113E3

Automation: **node:test**, [teamChatBindings.test.ts:86](../../packages/core/src/ai/assistant/teamChatBindings.test.ts#L86).
Title: **a runtime without native resume reconstructs the full bounded context once rather than sending a delta**.

**Given** an adapter that always uses the reconstructed prompt.
**When** two turns run in one chat.
**Then** the second prepared prompt holds the first turn and reply, the unused native delta does not, the receipt lists the full reconstruction, and no message is delivered twice.

### PT-A75870DFCA

Automation: **node:test**, [teamChatMigration.test.ts:29](../../packages/core/src/ai/assistant/teamChatMigration.test.ts#L29).
Title: **identity collisions fail without modifying the source**. Existing contract, strengthened by FX-BE-184 (gap G6); this entry supersedes the earlier wording.

**Given** a collision, a duplicate legacy message id and an unsupported schema version.
**When** migration or import throws.
**Then** each throws its named error and each input is deep-equal to its pre-call clone.

### PT-89F193A693

Automation: **node:test**, [teamChatMigration.test.ts:46](../../packages/core/src/ai/assistant/teamChatMigration.test.ts#L46).
Title: **a title-only match never merges or links**.

**Given** two legacy chats and one durable conversation sharing the title "Existing".
**When** migration runs.
**Then** three separate conversations remain with no bindings or turns, and the legacy transcript is complete.

### PT-CE0D0A3FCE

Automation: **node:test**, [teamChatMigration.test.ts:60](../../packages/core/src/ai/assistant/teamChatMigration.test.ts#L60).
Title: **a runtime session key quoted in message text is never treated as a provable association**. Formerly PT-A89FD06E4B ("a legacy runtime session key is never treated as a provable association"); TASK-485 (c750c105) renamed the test, so its id changed. PT-A89FD06E4B is retired. Listed here only, so it is counted once; the TASK-485 evidence tests that now carry the proof are in [FX-BE-183](fx-be-183-renderer-migration.md).

**Given** a legacy message mentioning a synthetic ASSISTANT-… session key, and no runtime session evidence.
**When** migration runs.
**Then** the conversation has no bindings, epoch "imported" and no participant ids on messages.

### PT-020116C43E

Automation: **node:test**, [teamChatRepository.test.ts:224](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L224).
Title: **ENOSPC and EACCES on temp write or fsync reject the acknowledgement and preserve committed bytes: ${code} at ${stage}**.

**Given** a committed durable chat; six cases (ENOSPC/EACCES at temp open, writeFile or sync) from one template title.
**When** a transaction runs while that call fails.
**Then** the transaction rejects with the code, the file is byte-identical, no temp file remains, and the next transaction commits from the old state.

### PT-DF4DDACEB9

Automation: **node:test**, [teamChatRepository.test.ts:250](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L250).
Title: **a truncated file, invalid JSON, wrong schemaVersion and a duplicate conversation id each fail load without rewriting**.

**Given** four malformed variants of a valid file, and a valid file truncated after load.
**When** a repository is constructed, or a transaction runs on the corrupted file.
**Then** each construction throws TeamChatStorageError and the transaction rejects; every file is left byte-identical.

### PT-315DCCA855

Automation: **node:test**, [teamChatRepository.test.ts:273](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L273).
Title: **two repository instances over one file are refused or serialized**.

**Given** two repository instances (two windows) over one file.
**When** 20 interleaved appends run concurrently.
**Then** all 20 messages land with sequences 1..20, conversation revision 20 and file revision 21.

### PT-ED8AC5EE8A

Automation: **node:test**, [teamChatRepository.test.ts:290](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L290).
Title: **a 10,000-message conversation commits under concurrent mutation of another chat within a recorded bound**.

**Given** a 10,000-message chat and a small chat in one file.
**When** five commits to each run concurrently from two instances.
**Then** all commits land, sizes and timings are logged as diagnostics (4.3 MB, 83–288 ms locally) and the slowest is under a generous 25 s ceiling.

### PT-4485239A20

Automation: **node:test**, [teamChatActivation.test.ts:77](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L77).
Title: **interrupted activation reuses a validated backup and uncertain commit requires reconciliation**. Existing contract, strengthened by FX-BE-184 (gap G6); this entry supersedes the earlier wording.

**Given** a validated backup and a rename that fails once, then a directory flush that fails after a later rename.
**When** activation retries, then a rename commits with an unflushed directory.
**Then** activation completes from the backup; on non-Windows platforms the uncertain commit throws TeamChatCommitUncertainError, later writes and activation are refused, the renamed bytes are on disk, and writes resume only after reconcile.

### PT-159068A7D0

Automation: **node:test**, [teamChatIpcRecovery.test.ts:38](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L38).
Title: **startup recovery reconciles a running attempt and resumes a queued turn before any chat is opened**.

**Given** bytes holding one chat crashed mid-dispatch and another with a durably accepted queued turn.
**When** a new services instance runs recoverOnStartup and nothing calls getConversation; then a third instance does the same.
**Then** only the queued chat dispatches and completes once, the dispatched attempt becomes outcome_unknown, and the third startup dispatches nothing.

### PT-57FD906F86

Automation: **node:test**, [teamChatIpcRecovery.test.ts:72](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L72).
Title: **startup recovery leaves a profile that never activated durable chat untouched**.

**Given** no file, then a legacy file, then the activation switch off.
**When** recoverOnStartup runs.
**Then** it returns false, creates no file or backup and leaves legacy bytes unchanged.

### PT-7231E7679E

Automation: **node:test**, [teamChatIpcRecovery.test.ts:86](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L86).
Title: **activation failure leaves durable dispatch disabled**.

**Given** a legacy file with a mismatched interrupted backup, and separately the activation switch off.
**When** submitTurn is called through the services.
**Then** every submit rejects, the provider is never called and the source is unchanged; after the bad backup is removed, activation and one dispatch succeed.

## Exact parameterized automation links

The two template ids above are stable source-group identities, not exact runtime-title ids. The following seven additional expansions (nine runtime cases replacing two source groups) explain the difference between 25 source contracts and 32 runtime cases. Every row inherits its group’s Given/When/Then and exact source line. These runtime ids are supplemental and are not validated by the Playwright-only generator.

| Runtime id | Source group / automation | Exact runtime title |
| --- | --- | --- |
| PT-6807379342 | PT-E4314C935F · [teamChatCrashBoundaries.test.ts:101](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L101) | crash after dispatch intent marks text-only attempts interrupted and tool-capable or opaque attempts outcome_unknown: text |
| PT-C1EFAE92A6 | PT-E4314C935F · [teamChatCrashBoundaries.test.ts:101](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L101) | crash after dispatch intent marks text-only attempts interrupted and tool-capable or opaque attempts outcome_unknown: tools |
| PT-F8EA47ECD7 | PT-E4314C935F · [teamChatCrashBoundaries.test.ts:101](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L101) | crash after dispatch intent marks text-only attempts interrupted and tool-capable or opaque attempts outcome_unknown: opaque |
| PT-631B008FED | PT-020116C43E · [teamChatRepository.test.ts:224](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L224) | ENOSPC and EACCES on temp write or fsync reject the acknowledgement and preserve committed bytes: ENOSPC at open |
| PT-17C2DF639D | PT-020116C43E · [teamChatRepository.test.ts:224](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L224) | ENOSPC and EACCES on temp write or fsync reject the acknowledgement and preserve committed bytes: ENOSPC at writeFile |
| PT-054023CB11 | PT-020116C43E · [teamChatRepository.test.ts:224](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L224) | ENOSPC and EACCES on temp write or fsync reject the acknowledgement and preserve committed bytes: ENOSPC at sync |
| PT-3207E3F7EE | PT-020116C43E · [teamChatRepository.test.ts:224](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L224) | ENOSPC and EACCES on temp write or fsync reject the acknowledgement and preserve committed bytes: EACCES at open |
| PT-88A2B4C4A4 | PT-020116C43E · [teamChatRepository.test.ts:224](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L224) | ENOSPC and EACCES on temp write or fsync reject the acknowledgement and preserve committed bytes: EACCES at writeFile |
| PT-5B98C84232 | PT-020116C43E · [teamChatRepository.test.ts:224](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L224) | ENOSPC and EACCES on temp write or fsync reject the acknowledgement and preserve committed bytes: EACCES at sync |

Registration: core contracts run through `packages/core/package.json` → `test` (root `test:core`); main contracts through `apps/praxis-desktop/main/package.json` → `test:git` (root `test:desktop:git`). The directory-flush/reconciliation assertions in PT-4485239A20 return early on Windows; its activation-retry assertions still run there. Internal scenario loops (four binding changes, four malformed files, two approval projections) are assertion scenarios within one test each, not extra runtime test registrations.

### PT-3544C516BE

Automation: **node:test**, [teamChatExecutionAdapter.test.ts:66](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L66).
Title: **unverified CLI identity cannot be stabilized by turn or participant account references**.

**Given** a CLI configuration with a claimed account reference in participant defaults or turn options.
**When** production preparation repeats within one turn and then prepares another turn.
**Then** same-turn validation is stable, but cross-turn account identity changes and cannot authorize native reuse. No provider dispatch occurs.

### PT-F19C6CE02C

Automation: **node:test**, [teamChatCoordinator.test.ts:844](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L844).
Title: **queued page identity and attachment references survive caller mutation before dispatch**.

**Given** a running turn held behind a barrier and a second accepted turn with issue context and an image reference.
**When** the caller changes the page identity, summary, draft and attachment list before releasing the first turn.
**Then** the queued provider invocation receives the original page identity, summary, text and immutable image reference. Both turns complete.

## WF-0C7166C7 implementation additions

### PT-DD3C1A1EA1

Automation: **node:test**, [teamChatExecutionAdapter.test.ts:91](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L91).
Title: **production API compatibility follows credentials, model and policy without exposing credentials**.

**Given** the production adapter resolving an API credential and captured policy.
**When** a second turn keeps the configuration, then the credential, model or policy changes.
**Then** compatible turns keep one binding; credential rotation invalidates it; model and policy changes alter compatibility; the resolved configuration contains no plaintext credential. This proves binding compatibility, not native CLI authentication or resume capability.

### PT-EE0AB4E23D

Automation: **Playwright**, [durableTeamChat.spec.ts:610](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L610).
Title: **queued page context and staged image reach the provider after navigation and composer replacement**.

**Given** a temporary profile, coordination root, attachment store and scripted ACP provider, with the first dispatch held at a barrier.
**When** an issue-context turn and PNG are queued, a replacement composer image is staged and the renderer reloads before dispatch is released.
**Then** the queued turn keeps its original page identity and immutable attachment references; only its prompt contains the captured page sentinel; the agent receives exactly one PNG. The earlier prompt excludes the future queued page context.

The live-provider checks now retain per-member reuse classification, native context receipts and runtime recovery evidence. Six distinct completed attempts and session isolation are asserted; a reconstruction pass explicitly leaves native reuse unproved. Production has no authoritative CLI account reference, so the conservative per-turn identity remains in place.

## WF-0C7166C7 resumed implementation: native delivery evidence

Execution source: `fafbacc8`, with timestamped live receipt retention in `1018ed98` (recovery base `67968cf0`). The existing assertion **compatible members retain one binding each across turns and chats remain isolated; usage commits once** in `teamChatCoordinator.test.ts` now exercises a compatible native adapter: four distinct attempts reuse exactly two isolated member sessions; dispatch receives the persisted session identity; completion records the native context receipt without already-delivered history; another conversation creates independent sessions. Usage still commits once. This is deterministic adapter evidence, not real CLI authentication proof.

The existing real CLI/API continuation assertions in `durableTeamChat.live.spec.ts` now require both members to recall the pinned codename after restart, check session isolation on all three turns, and classify native reuse only when matching session IDs are accompanied by durable `final_result.result.contextDelivery === 'native'` evidence. A matching session ID by itself cannot establish native delivery. Reconstruction remains a separate successful continuation result with native reuse explicitly unproved.

No production identity fallback, permission classification, runtime checks or test registration was weakened. The conservative per-turn CLI identity and unknown-outcome reconciliation gates remain intact. Live receipts use timestamped filenames and Playwright JSON attachments to preserve prior runs. Current runner results and retained artifacts are recorded separately in the verification report.

## TASK-486 failure-matrix additions

Added in TASK-486 (2026-11-06). The template id below is a source-group identity; its two runtime ids follow the same rule as the parameterized table above.

### PT-BAFAF71874

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:369](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L369).
Title: **crash while a turn is cancelling settles text-only work as cancelled and tool-capable work as outcome_unknown, never dispatching skipped members or cancelled queued turns: ${capability}**.
Runtime ids: PT-84EF0A45E2 (`text-only`), PT-57F44DA3DF (`tool-capable`).

**Given** a two-member turn whose dev attempt is running, a second turn queued behind it, and a Stop committed (`cancelling`, lead skipped, queued turn cancelled) before the runtime acknowledges the abort.
**When** the process dies and a new coordinator initializes over those bytes, then a second restart follows.
**Then** no provider runs; a text-only attempt and its turn end `cancelled`, a tool-capable attempt and its turn end `outcome_unknown` and refuse a plain retry; both carry a reconciliation record from the new epoch; the skipped member and the cancelled queued turn are unchanged; the second restart changes nothing.

### PT-3819088619

Automation: **node:test**, [teamChatCrashBoundaries.test.ts:411](../../packages/core/src/ai/assistant/teamChatCrashBoundaries.test.ts#L411).
Title: **a final result persisted for a cancelling turn imports exactly once at restart and never runs the members Stop skipped**.

**Given** a cancelling text-only turn (lead skipped by Stop) whose running dev attempt holds a durable `final_result` that was never imported.
**When** a new coordinator initializes, twice in succession.
**Then** the reply is imported exactly once, the turn completes with lead still skipped, and no provider is invoked in either restart.

### PT-C5D91CE0A1

Automation: **node:test**, [acpAgentHost.test.ts:593](../../packages/core/src/ai/acp/acpAgentHost.test.ts#L593).
Title: **durable ACP continuation sends only prepared context on native resume, and full reconstruction when resume is unavailable or advertised but failing**.
Supersedes PT-1AE4FF6CEF (renamed; see [fx-be-181-provider-context.md](fx-be-181-provider-context.md#pt-c5d91ce0a1)).

**Given** a temporary scripted ACP subprocess on the real wire, a prior session and distinct prepared reconstruction/continuation strings.
**When** continuation runs with resume advertised and working, not advertised, and advertised but answered with a JSON-RPC error (`session/resume` / `session/load`).
**Then** the native case sends only the continuation; both other cases send the full prepared reconstruction once and record `teamChatContextDelivery === 'reconstruction'`; every case completes.

### PT-6A2E85CA23

Automation: **node:test**, [teamChatIpcRecovery.test.ts:384](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L384).
Title: **a Stop interrupted by process exit stays stopped after restart on the file repository**.

**Given** a temporary profile's `team-chats.json`, a text-only member that never settles, a queued second turn and a committed Stop (`cancelling`).
**When** a second services instance runs startup recovery over the same file while the first execution is still unsettled.
**Then** no provider runs; the turn and attempt are `cancelled`, the queued turn stays cancelled, no reply is written and no `turn_failed` (retry) update is emitted.

Registration: unchanged. The core cases run in `packages/core/package.json` → `test`; the main case in `apps/praxis-desktop/main/package.json` → `test:git`. No Playwright spec changed, so `catalog.json` is not regenerated.
