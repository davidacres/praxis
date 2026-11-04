# FX-BE-184 release-proof node:test contracts

Runner: **node:test**. These **25 supplemental cases** (two of them existing tests strengthened here) cover crash boundaries, provider context and bindings, migration, persistence faults, activation and startup recovery. They sit outside the Playwright-only generator. IDs use SHA1(file + newline + exact title), the same rule as the catalog; two titles are template literals and stand for their parameterized cases. No new id collides with a catalog id or an earlier FX-BE supplement.

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

**Given** a running full-tools manual-permission attempt, as production stores it and with an awaiting_approval projection.
**When** a new coordinator initializes and the user retries with reconciliation evidence and the duplicate-risk acknowledgement.
**Then** the recovered attempt is interrupted or outcome_unknown (recorded deviation: tool-capable is outcome_unknown, not the matrix's interrupted); the replacement is ordinal 2 with permissionMode manual, no autoApprovePermissions and no carried evidence.

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

### PT-A89FD06E4B

Automation: **node:test**, [teamChatMigration.test.ts:60](../../packages/core/src/ai/assistant/teamChatMigration.test.ts#L60).
Title: **a legacy runtime session key is never treated as a provable association**.

**Given** a legacy message mentioning a synthetic ASSISTANT-… session key.
**When** migration runs.
**Then** the conversation has no bindings, epoch "imported" and no participant ids on messages.

### PT-020116C43E

Automation: **node:test**, [teamChatRepository.test.ts:193](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L193).
Title: **ENOSPC and EACCES on temp write or fsync reject the acknowledgement and preserve committed bytes: ${code} at ${stage}**.

**Given** a committed durable chat; six cases (ENOSPC/EACCES at temp open, writeFile or sync) from one template title.
**When** a transaction runs while that call fails.
**Then** the transaction rejects with the code, the file is byte-identical, no temp file remains, and the next transaction commits from the old state.

### PT-DF4DDACEB9

Automation: **node:test**, [teamChatRepository.test.ts:219](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L219).
Title: **a truncated file, invalid JSON, wrong schemaVersion and a duplicate conversation id each fail load without rewriting**.

**Given** four malformed variants of a valid file, and a valid file truncated after load.
**When** a repository is constructed, or a transaction runs on the corrupted file.
**Then** each construction throws TeamChatStorageError and the transaction rejects; every file is left byte-identical.

### PT-315DCCA855

Automation: **node:test**, [teamChatRepository.test.ts:242](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L242).
Title: **two repository instances over one file are refused or serialized**.

**Given** two repository instances (two windows) over one file.
**When** 20 interleaved appends run concurrently.
**Then** all 20 messages land with sequences 1..20, conversation revision 20 and file revision 21.

### PT-ED8AC5EE8A

Automation: **node:test**, [teamChatRepository.test.ts:259](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L259).
Title: **a 10,000-message conversation commits under concurrent mutation of another chat within a recorded bound**.

**Given** a 10,000-message chat and a small chat in one file.
**When** five commits to each run concurrently from two instances.
**Then** all commits land, sizes and timings are logged as diagnostics (4.3 MB, 83–288 ms locally) and the slowest is under a generous 25 s ceiling.

### PT-4485239A20

Automation: **node:test**, [teamChatActivation.test.ts:76](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L76).
Title: **interrupted activation reuses a validated backup and uncertain commit requires reconciliation**. Existing contract, strengthened by FX-BE-184 (gap G6); this entry supersedes the earlier wording.

**Given** a validated backup and a rename that fails once, then a directory flush that fails after a later rename.
**When** activation retries, then a rename commits with an unflushed directory.
**Then** activation completes from the backup; the uncertain commit throws TeamChatCommitUncertainError, later writes and activation are refused, the renamed bytes are on disk, and writes resume only after reconcile.

### PT-159068A7D0

Automation: **node:test**, [teamChatIpcRecovery.test.ts:35](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L35).
Title: **startup recovery reconciles a running attempt and resumes a queued turn before any chat is opened**.

**Given** bytes holding one chat crashed mid-dispatch and another with a durably accepted queued turn.
**When** a new services instance runs recoverOnStartup and nothing calls getConversation; then a third instance does the same.
**Then** only the queued chat dispatches and completes once, the dispatched attempt becomes outcome_unknown, and the third startup dispatches nothing.

### PT-57FD906F86

Automation: **node:test**, [teamChatIpcRecovery.test.ts:69](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L69).
Title: **startup recovery leaves a profile that never activated durable chat untouched**.

**Given** no file, then a legacy file, then the activation switch off.
**When** recoverOnStartup runs.
**Then** it returns false, creates no file or backup and leaves legacy bytes unchanged.

### PT-7231E7679E

Automation: **node:test**, [teamChatIpcRecovery.test.ts:83](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L83).
Title: **activation failure leaves durable dispatch disabled**.

**Given** a legacy file with a mismatched interrupted backup, and separately the activation switch off.
**When** submitTurn is called through the services.
**Then** every submit rejects, the provider is never called and the source is unchanged; after the bad backup is removed, activation and one dispatch succeed.
