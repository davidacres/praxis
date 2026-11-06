# FX-BE-183 renderer subscription and legacy migration contracts

Frozen snapshot: `622613fbed15edab22f77d4c2597e3bf784f1b4a` for the first 17 cases; `f27d2793958dbf817c6bea7d06ae474704ad8b55` for the first six TASK-484 sections; `a1f5ecbbf28dfac0de20a85fcc4ee2c3757bec77` for the submit-command section and every line link in this file (all 73 re-audited there). Runner: **node:test**. These **73 supplemental cases** are 8 activation/repository cases, 3 migration cases, 3 coordinator cases and 3 renderer subscription cases, plus 56 TASK-484 renderer cases (18 turn controls, 11 error visibility, 6 pending submissions, 6 sidebar ownership, 4 apply-page compatibility, 5 dock/float shell, 6 submit command). They sit outside the Playwright-only generator. IDs use SHA1(file + newline + exact title), the same rule as the catalog, and none collides with a catalog id.

## Activation and cutover — `apps/praxis-desktop/main/src/main/teamChatActivation.test.ts`

### PT-1FC2813D4B

Automation: **node:test**, [teamChatActivation.test.ts:18](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L18).
Title: **quiescence fences new legacy requests and waits for text-only calls and saves**.

**Given** a TeamChatActivation with one legacy operation held open.
**When** activation starts and another legacy request arrives.
**Then** the new legacy request is rejected as disabled, and the commit runs only after the held operation settles.

### PT-0651E34994

Automation: **node:test**, [teamChatActivation.test.ts:30](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L30).
Title: **backup preserves exact bytes, migration is idempotent and legacy writes are rejected**.

**Given** a team-chats.json with one legacy chat for project `p`.
**When** the file repository activates twice and a TeamChatStore lists, saves and renames.
**Then** the `.v1-backup` holds the exact original bytes, the second activation leaves the file unchanged, the chat lists once under `p`, `saveMessages` is rejected as a replacement writer, and a rename persists across a fresh repository.

### PT-5FFDF30323

Automation: **node:test**, [teamChatActivation.test.ts:44](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L44).
Title: **backup failure or mismatched interrupted backup never replaces source**.

**Given** a `.v1-backup` file with invalid content.
**When** the repository activates.
**Then** activation is rejected with a backup error and the source file is byte-identical. Only the mismatched-backup path is exercised, not a failed backup write.

### PT-42C5554A52

Automation: **node:test**, [teamChatActivation.test.ts:51](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L51).
Title: **queued attachments retain bytes after composer mutation and reject cross-conversation ownership**.

**Given** an image staged for conversation `one`.
**When** the caller's image buffer is edited and a fresh TeamChatAttachments instance resolves the reference.
**Then** the original bytes are returned; resolving for conversation `two`, a size mismatch (integrity) and a non-image media type are all rejected.

### PT-6C6C6D9394

Automation: **node:test**, [teamChatActivation.test.ts:64](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L64).
Title: **restoration is allowed only before durable acceptance**.

**Given** an activated repository.
**When** it is restored, re-activated, marked as having accepted new turns, then restored again.
**Then** the first restore returns the original bytes; the second is rejected as needing forward repair and `acceptedNewTurns` stays true.

### PT-4485239A20

Automation: **node:test**, [teamChatActivation.test.ts:76](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L76).
Title: **interrupted activation reuses a validated backup and uncertain commit requires reconciliation**.

**Given** a valid existing backup and `fs.promises.rename` mocked to fail once.
**When** activation runs, fails, and runs again with rename restored.
**Then** the source is unchanged after the failure, and the retry migrates the chat into `conversations` with no legacy `teamChats` left. The title's "uncertain commit requires reconciliation" is not asserted: no reconciliation step is checked (finding).

### PT-8053335DC2

Automation: **node:test**, [teamChatActivation.test.ts:105](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L105).
Title: **disabled activation never commits or fences unrelated legacy work**.

**Given** a TeamChatActivation constructed disabled.
**When** activation is requested and then a legacy call runs.
**Then** activation is rejected without committing, and the legacy call still returns its value.

### PT-63819EA534

Automation: **node:test**, [teamChatActivation.test.ts:113](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L113).
Title: **a failed commit lifts the fence so legacy work resumes and activation can retry**.

**Given** an activation whose commit throws "disk full".
**When** legacy work runs, then activation is retried successfully.
**Then** legacy work succeeds after the failure, the retry commits, and legacy work is fenced again afterwards.

## Migration — `packages/core/src/ai/assistant/teamChatMigration.test.ts`

### PT-0FF1EBFFE5

Automation: **node:test**, [teamChatMigration.test.ts:13](../../packages/core/src/ai/assistant/teamChatMigration.test.ts#L13).
Title: **migration is deterministic, lossless, isolated and never schedules imported history**.

**Given** a schema-2 snapshot with one legacy chat holding an error orphan, a user message with context, and a reply with choices and an update-ticket action.
**When** it is migrated twice, and the result is migrated again.
**Then** both runs are equal, the input is unchanged, legacy `teamChats` is emptied, the issue key and every message field (ids, roles, text, timestamps, errors, choices, actions) survive, sequences are 1-3, the orphan is `imported-unknown`, the question and answer share a turn id, no turns or bindings are created, and re-migration is a no-op.

### PT-A75870DFCA

Automation: **node:test**, [teamChatMigration.test.ts:29](../../packages/core/src/ai/assistant/teamChatMigration.test.ts#L29).
Title: **identity collisions fail without modifying the source**.

**Given** a snapshot whose conversations already contain the imported chat, a chat with a duplicated message id, and a schema-99 snapshot.
**When** each is migrated or imported.
**Then** each throws (collision, Duplicate, Unsupported). "Without modifying the source" is not asserted after the throw.

### PT-A1FF0FEC99

Automation: **node:test**, [teamChatMigration.test.ts:71](../../packages/core/src/ai/assistant/teamChatMigration.test.ts#L71).
Title: **ambiguous legacy results remain diagnostics rather than invented successful attempts**.

**Given** a snapshot carrying an unbound legacy result diagnostic.
**When** it is migrated.
**Then** the diagnostic is kept as-is and the migrated conversation has no turns.

## Coordinator controls — `packages/core/src/ai/assistant/teamChatCoordinator.test.ts`

### PT-D81B94C6F4

Automation: **node:test**, [teamChatCoordinator.test.ts:796](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L796).
Title: **revisioned controls reject stale targets and persist idempotent command outcomes**.

**Given** a conversation with one decision message.
**When** a pin command is sent twice, re-sent with a different message id, sent as an unpin at the old revision, then as an unpin at the current revision.
**Then** the repeat returns the same revision with one receipt, the conflicting payload is rejected, the stale unpin leaves the pin, and the current unpin clears it.

### PT-824F86BCDF

Automation: **node:test**, [teamChatCoordinator.test.ts:816](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L816).
Title: **deletion during dispatch fences late results and never recreates a conversation**.

**Given** a turn whose execution is held open.
**When** the conversation is removed and the execution then returns a reply.
**Then** the conversation stays absent from the coordinator and the repository.

### PT-BCE1A74F9A

Automation: **node:test**, [teamChatCoordinator.test.ts:833](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L833).
Title: **a structured execution result and original page identity survive completion**.

**Given** a turn submitted with issue page context `P-1` and an executor returning choices and an update-ticket action.
**When** the turn completes.
**Then** the reply keeps issue key `P-1`, the update-ticket action and the choice prompt. It does not navigate or apply the action.

## Renderer subscription — `apps/praxis-desktop/renderer/test/conversationSubscription.test.ts`

### PT-A7677CB1BA

Automation: **node:test**, [conversationSubscription.test.ts:9](../../apps/praxis-desktop/renderer/test/conversationSubscription.test.ts#L9).
Title: **a read that never reaches the notified revision is retried a bounded number of times**.

**Given** a bridge whose reads always return revision 1.
**When** a revision-5 notification arrives.
**Then** exactly `STALE_READ_RETRIES + 1` further reads happen and only revision 1 is published.

### PT-8277D6BF06

Automation: **node:test**, [conversationSubscription.test.ts:27](../../apps/praxis-desktop/renderer/test/conversationSubscription.test.ts#L27).
Title: **a lagging read that catches up publishes the notified revision**.

**Given** a bridge whose revision rises by one on every read.
**When** a revision-4 notification arrives.
**Then** revision 4 is the last one published.

### PT-1DB6829ECC

Automation: **node:test**, [conversationSubscription.test.ts:43](../../apps/praxis-desktop/renderer/test/conversationSubscription.test.ts#L43).
Title: **a conversation-update error is surfaced at the loaded revision while snapshot ordering stays monotonic**.

**Given** a subscription whose snapshot is loaded at revision 3.
**When** an update carrying a loop-stop error arrives at revision 3, then another at revision 5, then a stale revision-2 update.
**Then** each error reaches the error callback without an extra read; the equal-revision error does not republish, and snapshots published are only 3 then 5.

## TASK-484 Turn controls and keyboard — `apps/praxis-desktop/renderer/test/turnControlModel.test.ts`

### PT-92969AEB8D

Automation: **node:test**, [turnControlModel.test.ts:66](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L66).
Title: **a running turn offers a labelled, enabled Stop fenced by conversation, revision, turn and attempt**.

**Given** a conversation at revision 7 with one running turn `t1` on attempt `a1`.
**When** its turn card is described.
**Then** the only control is an enabled **Stop** (label and accessible name "Stop", test id `assistant-turn-stop`, the stop key hint) whose command is `cancelTurn` carrying conversation, command id, expected revision 7, turn `t1` and attempt `a1`.

### PT-9E606FAEC0

Automation: **node:test**, [turnControlModel.test.ts:82](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L82).
Title: **a queued turn offers only cancellation of that queued turn, and the card names its position**.

**Given** a queued turn with no attempts, second in line.
**When** its card is described.
**Then** the heading is "Queued 2", the accessible name "Queued turn 2", it does not need attention, and its only control is **Cancel queued turn** (`assistant-turn-cancel-queued`) issuing `cancelTurn`.

### PT-637CF1FED3

Automation: **node:test**, [turnControlModel.test.ts:91](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L91).
Title: **cancelling relabels and disables Stop with the reason a stop is already in flight**.

**Given** a turn in state `cancelling`.
**When** its card is described.
**Then** Stop is relabelled "Stopping…", disabled, and carries the reason "A stop command is already in flight."

### PT-927686F7E1

Automation: **node:test**, [turnControlModel.test.ts:99](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L99).
Title: **a failed turn retries its member, naming the member who has not completed**.

**Given** a failed turn where `dev` completed and `qa`'s attempt `a2` failed with "provider refused".
**When** its card is described.
**Then** the heading and accessible name name `qa`, the alert shows the error, it needs attention, and the controls are **Retry qa** then Stop; Retry issues `retryParticipant` for attempt `a2` and participant `part-qa`.

### PT-AD840E7667

Automation: **node:test**, [turnControlModel.test.ts:118](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L118).
Title: **an interrupted turn with no attempt to retry disables Retry and says why**.

**Given** an interrupted turn with no attempts.
**When** its card is described.
**Then** Retry is disabled with the reason "This turn has no attempt to retry."

### PT-A34F9B1A04

Automation: **node:test**, [turnControlModel.test.ts:125](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L125).
Title: **context_required offers Recheck context as a resume-context control and surfaces the reason**.

**Given** a `context_required` turn with reason "Pinned source is missing.".
**When** its card is described.
**Then** the reason is shown as the context alert (not the error alert), the card needs attention, and the first control is **Recheck context** (`assistant-turn-recheck-context`) issuing a `control` command with action `resume-context`.

### PT-AE61A9350E

Automation: **node:test**, [turnControlModel.test.ts:138](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L138).
Title: **outcome_unknown gates its retry on a recorded reconciliation and an accepted duplicate-action risk**.

**Given** an `outcome_unknown` turn with no recorded reconciliation.
**When** its card is described with no note, with a typed note, and with only the risk acknowledged.
**Then** the controls are note field, Record reconciliation, risk checkbox, retry and stop; Record is disabled until a note is typed and then issues `resolveAttempt` with `reconcile` and the note; the retry stays disabled ("Record what you checked…") in all three states.

### PT-681C9A8FEB

Automation: **node:test**, [turnControlModel.test.ts:175](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L175).
Title: **recorded reconciliation evidence unlocks the retry once the risk is acknowledged, carrying the evidence id**.

**Given** an `outcome_unknown` attempt carrying reconciliation evidence `ev-1`, with the risk acknowledged.
**When** its card is described.
**Then** the retry is enabled and issues `resolveAttempt` with `retry`, `acknowledgeDuplicateActionRisk: true` and evidence id `ev-1`; the resolve-cancel control is labelled Stop and stays enabled.

### PT-A6A0E78880

Automation: **node:test**, [turnControlModel.test.ts:192](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L192).
Title: **reconciliation evidence on an earlier attempt does not unlock a newer one**.

**Given** an `outcome_unknown` turn whose earlier attempt `a1` has reconciliation evidence and whose latest attempt `a2` has none, with the risk acknowledged.
**When** its card is described.
**Then** the retry stays disabled with the "Record what you checked" reason.

### PT-75CB200106

Automation: **node:test**, [turnControlModel.test.ts:201](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L201).
Title: **the panel shows one card per unsettled turn, oldest first, and hides settled ones**.

**Given** a conversation with running, queued, completed and cancelled turns.
**When** the panel's cards are described.
**Then** only the running card ("dev: running") and the queued card ("Queued 2") appear, in that order.

### PT-FE3B907B00

Automation: **node:test**, [turnControlModel.test.ts:211](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L211).
Title: **every control carries a distinct data-testid the specs can select**.

**Given** one turn in each of running, queued, failed, context_required, outcome_unknown and cancelling.
**When** all cards are described.
**Then** every turn+test-id pair is unique and each of the nine control test ids appears at least once.

### PT-EAA7BF25B7

Automation: **node:test**, [turnControlModel.test.ts:228](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L228).
Title: **⌘/Ctrl+. stops the turn in flight and ⌘/Ctrl+Shift+R retries the most recent retryable attempt**.

**Given** a running turn `t1` and a failed turn `t2`.
**When** key chords are resolved against the cards.
**Then** Ctrl+. and ⌘. resolve to Stop on `t1`; Ctrl+Shift+R resolves to Retry on `t2`; plain Ctrl+R (reload) resolves to nothing. Pure resolver; the panel's keydown listener is not driven.

### PT-CEAE68BD12

Automation: **node:test**, [turnControlModel.test.ts:245](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L245).
Title: **⌘/Ctrl+Enter records the reconciliation only while it is the single enabled recovery action**.

**Given** one `outcome_unknown` card with a typed note, then a second card whose retry is unlocked.
**When** Ctrl+Enter is resolved.
**Then** with one card it resolves to Record reconciliation; with two enabled recovery actions it resolves to nothing.

### PT-FE19C3FFCB

Automation: **node:test**, [turnControlModel.test.ts:258](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L258).
Title: **⌘/Ctrl+Enter typed in the composer sends the message only; it never records a reconciliation**.

**Given** recovery cards and a key press flagged as coming from an editing surface.
**When** Ctrl/⌘+Enter, Ctrl+Shift+R and Ctrl+. are resolved.
**Then** Enter and Shift+R resolve to nothing from a text field; Ctrl+. still resolves to Stop. That the composer then sends is not asserted here.

### PT-CDB5A6BB83

Automation: **node:test**, [turnControlModel.test.ts:272](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L272).
Title: **editing surfaces are inputs, textareas, selects and contenteditable elements**.

**Given** element-like objects.
**When** `isEditingSurface` classifies them.
**Then** TEXTAREA, input and a contenteditable DIV are editing surfaces; BUTTON and null are not. SELECT is named in the title but not asserted (finding).

### PT-7C18D36E7B

Automation: **node:test**, [turnControlModel.test.ts:280](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L280).
Title: **a plain key press, an alt-modified one, or a binding with nothing enabled is not ours**.

**Given** a running turn, and separately a cancelling one.
**When** an unmodified r, Ctrl+Alt+., Ctrl+Shift+., Ctrl+Z, and Ctrl+. against the cancelling card are resolved.
**Then** each resolves to nothing.

### PT-6E7FEB9FCB

Automation: **node:test**, [turnControlModel.test.ts:291](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L291).
Title: **each documented binding names what it does, and every recovery control has a key hint**.

**Given** the binding table and a failed turn's card.
**When** they are inspected.
**Then** the bindings are `.`, `r`, `Enter`, each with a description and the `mod` combo, and every recovery control carries a key hint.

### PT-44BF2670FC

Automation: **node:test**, [turnControlModel.test.ts:301](../../apps/praxis-desktop/renderer/test/turnControlModel.test.ts#L301).
Title: **the member a turn is waiting on is the first planned participant that has not completed**.

**Given** a turn planned for dev then qa.
**When** completion progresses.
**Then** the active member is dev, then qa, then none; a failed card with nobody identifiable is headed "Team: failed" with accessible name "Turn for the team: failed".

## TASK-484 Error visibility — `apps/praxis-desktop/renderer/test/assistantErrorState.test.ts`

### PT-4491F9A277

Automation: **node:test**, [assistantErrorState.test.ts:25](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L25).
Title: **a live failure stays visible while a later snapshot still carries it**.

**Given** an error "Provider refused" and a snapshot whose failed turn still carries it.
**When** the error is resolved against the snapshot.
**Then** it stays shown and is listed as unresolved.

### PT-09F7D3297F

Automation: **node:test**, [assistantErrorState.test.ts:31](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L31).
Title: **a snapshot that merely omits the error is not a resolution for an unattributable error**.

**Given** an apply-refusal error that names no turn and a snapshot with no turns.
**When** the error is resolved.
**Then** it stays shown.

### PT-78BE7EE221

Automation: **node:test**, [assistantErrorState.test.ts:37](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L37).
Title: **no snapshot at all keeps the error: a reload or a chat switch cannot blank a live failure**.

**Given** an error and no snapshot.
**When** the error is resolved.
**Then** it stays shown.

### PT-8DB52ECB5E

Automation: **node:test**, [assistantErrorState.test.ts:41](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L41).
Title: **a settled turn resolves its own error**.

**Given** a completed turn whose earlier attempt failed.
**When** the error is resolved.
**Then** it clears and nothing is unresolved.

### PT-A676CEEB78

Automation: **node:test**, [assistantErrorState.test.ts:47](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L47).
Title: **a cancelled turn resolves its own error**.

**Given** a cancelled turn.
**When** its error is resolved.
**Then** it clears.

### PT-E159AF3259

Automation: **node:test**, [assistantErrorState.test.ts:52](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L52).
Title: **a newer attempt supersedes the failed one, so its error resolves**.

**Given** a running turn with failed attempt `a1` and running attempt `a2`.
**When** the error is resolved.
**Then** it clears.

### PT-030D8B814F

Automation: **node:test**, [assistantErrorState.test.ts:57](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L57).
Title: **a context-required reason stays until the turn moves on**.

**Given** a `context_required` turn with a reason, then the same turn running.
**When** the reason is resolved against each snapshot.
**Then** it stays while blocked, clears once the previous snapshot shows the turn left `context_required`, and stays when there is no previous snapshot to compare.

### PT-DCDAF64954

Automation: **node:test**, [assistantErrorState.test.ts:67](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L67).
Title: **an incoming error replaces whatever was shown, resolved or not**.

**Given** an old error.
**When** a new error arrives, then an undefined incoming error.
**Then** the new error replaces the old; undefined leaves the old one.

### PT-DEFB098902

Automation: **node:test**, [assistantErrorState.test.ts:73](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L73).
Title: **the user can dismiss, and dismissal wins over a still-unresolved snapshot**.

**Given** an unresolved failure in the snapshot.
**When** the user dismisses.
**Then** the error clears. The Dismiss button itself is not driven (finding).

### PT-B0B05FC202

Automation: **node:test**, [assistantErrorState.test.ts:79](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L79).
Title: **a submission whose acknowledgement was lost clears once it is acknowledged**.

**Given** a "Lost acceptance acknowledgement" error.
**When** the submission is acknowledged, or the conversation changes.
**Then** it clears in both cases.

### PT-F6064101EE

Automation: **node:test**, [assistantErrorState.test.ts:85](../../apps/praxis-desktop/renderer/test/assistantErrorState.test.ts#L85).
Title: **switching to another conversation drops an error that belongs to the first one**.

**Given** an unresolved failure.
**When** the conversation changes.
**Then** the error clears.

## TASK-484 Pending submissions — `apps/praxis-desktop/renderer/test/assistantPendingSubmissions.test.ts`

### PT-BD0CF99286

Automation: **node:test**, [assistantPendingSubmissions.test.ts:22](../../apps/praxis-desktop/renderer/test/assistantPendingSubmissions.test.ts#L22).
Title: **a recorded submission is found by its own conversation, not by whatever is open now**.

**Given** a submission recorded for `conv-a` with page context and an attachment ref.
**When** it is looked up by `conv-a`, by `conv-b`, and by other text.
**Then** only the `conv-a` lookup finds it, with the same command id, attachment refs and context, so a transport retry reuses one command.

### PT-41278197F0

Automation: **node:test**, [assistantPendingSubmissions.test.ts:39](../../apps/praxis-desktop/renderer/test/assistantPendingSubmissions.test.ts#L39).
Title: **attachments are staged once: a retry reuses the refs the first attempt wrote**.

**Given** a submission recorded with staged attachments, and a text-only one.
**When** staging is queried.
**Then** the first reports staged attachments; the text-only one does not.

### PT-62990BC025

Automation: **node:test**, [assistantPendingSubmissions.test.ts:49](../../apps/praxis-desktop/renderer/test/assistantPendingSubmissions.test.ts#L49).
Title: **two conversations can hold a submission each, keyed independently**.

**Given** submissions recorded for `conv-a` and `conv-b`.
**When** the pending list is read.
**Then** both are kept, in order.

### PT-96EC2E8958

Automation: **node:test**, [assistantPendingSubmissions.test.ts:57](../../apps/praxis-desktop/renderer/test/assistantPendingSubmissions.test.ts#L57).
Title: **acknowledging clears only that submission**.

**Given** pending submissions in `conv-a` and `conv-b`.
**When** `conv-a`'s is acknowledged.
**Then** only `conv-b`'s remains.

### PT-FA89B07F58

Automation: **node:test**, [assistantPendingSubmissions.test.ts:67](../../apps/praxis-desktop/renderer/test/assistantPendingSubmissions.test.ts#L67).
Title: **deleting a conversation drops only its own pending submissions**.

**Given** two submissions in `conv-a` and one in `conv-b`.
**When** `conv-a` is dropped.
**Then** only `conv-b`'s remains.

### PT-EFA0589DF2

Automation: **node:test**, [assistantPendingSubmissions.test.ts:77](../../apps/praxis-desktop/renderer/test/assistantPendingSubmissions.test.ts#L77).
Title: **a conversation id that is a prefix of another never matches it**.

**Given** submissions for `conv` and `conv-long`.
**When** `conv` is dropped.
**Then** `conv-long`'s remains.

## TASK-484 Sidebar ownership — `apps/praxis-desktop/renderer/test/assistantOwnership.test.ts`

### PT-34346A5FF8

Automation: **node:test**, [assistantOwnership.test.ts:33](../../apps/praxis-desktop/renderer/test/assistantOwnership.test.ts#L33).
Title: **the shared classifier names exactly the assistant-owned sessions**.

**Given** six sessions: a typed `teamChatExecution`, a legacy `ASSISTANT-` record, a standalone chat, a ticket session, a workflow stage and a ticket review.
**When** each is classified.
**Then** only the first two are assistant-owned.

### PT-2DE5B3792B

Automation: **node:test**, [assistantOwnership.test.ts:39](../../apps/praxis-desktop/renderer/test/assistantOwnership.test.ts#L39).
Title: **visibleSessions removes only assistant-owned executions, on initial load and increments alike**.

**Given** the same six sessions, then a single pushed team-chat execution, then a single pushed standalone chat.
**When** `visibleSessions` filters each list.
**Then** the four non-owned sessions remain; the pushed execution yields nothing; the pushed standalone chat is kept.

### PT-B0CE13F1CA

Automation: **node:test**, [assistantOwnership.test.ts:49](../../apps/praxis-desktop/renderer/test/assistantOwnership.test.ts#L49).
Title: **the exclusion does not change what counts as a conversation, a workflow stage or a ticket review**.

**Given** a standalone chat and a team-chat execution.
**When** the existing session-nav predicates run.
**Then** both still count as conversations, only one survives `visibleSessions`, and workflow-stage and ticket-review detection are unchanged.

### PT-9AA594E12B

Automation: **node:test**, [assistantOwnership.test.ts:60](../../apps/praxis-desktop/renderer/test/assistantOwnership.test.ts#L60).
Title: **Easy Mode root-session filtering keeps standalone chats and hides internal executions**.

**Given** a root chat, its child, a workflow-run session and a team-chat execution.
**When** they are filtered by `visibleSessions` plus a root filter copied from the Easy Mode sidebar.
**Then** only the root chat remains. The filter is mirrored in the test, not imported from the sidebar components (finding).

### PT-1382063EA4

Automation: **node:test**, [assistantOwnership.test.ts:75](../../apps/praxis-desktop/renderer/test/assistantOwnership.test.ts#L75).
Title: **one team-chat row per conversation id, whichever feed listed it first**.

**Given** chat `c1` listed by the general feed and again by a project feed, plus `c2`.
**When** `dedupeTeamChats` runs.
**Then** one row each for `c1` (the first listing) and `c2`.

### PT-49235A44B7

Automation: **node:test**, [assistantOwnership.test.ts:83](../../apps/praxis-desktop/renderer/test/assistantOwnership.test.ts#L83).
Title: **an empty list stays empty and a single chat is unchanged**.

**Given** an empty list and a one-chat list.
**When** `dedupeTeamChats` runs.
**Then** both come back unchanged.

## TASK-484 Apply-page compatibility — `apps/praxis-desktop/renderer/test/assistantPageContextCompatibility.test.ts`

### PT-80C40253A2

Automation: **node:test**, [assistantPageContextCompatibility.test.ts:12](../../apps/praxis-desktop/renderer/test/assistantPageContextCompatibility.test.ts#L12).
Title: **the same page is compatible, however its summary or prompts drift**.

**Given** an issue or board page context.
**When** it is compared with itself and with changed summary, data or prompts.
**Then** it is compatible.

### PT-1E88700FF1

Automation: **node:test**, [assistantPageContextCompatibility.test.ts:18](../../apps/praxis-desktop/renderer/test/assistantPageContextCompatibility.test.ts#L18).
Title: **a different page is not compatible**.

**Given** an issue page context.
**When** it is compared with a board, a git page, another issue, a renamed title, another project, and another board id.
**Then** none is compatible.

### PT-6D6CA3D53C

Automation: **node:test**, [assistantPageContextCompatibility.test.ts:28](../../apps/praxis-desktop/renderer/test/assistantPageContextCompatibility.test.ts#L28).
Title: **a missing origin or a page with no registered context is never compatible**.

**Given** an undefined origin, an undefined current page, or both.
**When** they are compared.
**Then** none is compatible.

### PT-83457E3DBE

Automation: **node:test**, [assistantPageContextCompatibility.test.ts:34](../../apps/praxis-desktop/renderer/test/assistantPageContextCompatibility.test.ts#L34).
Title: **the refusal is one message, stated once**.

**Given** the incompatible-page message.
**When** it is read through the function and the constant.
**Then** both are "Return to the originating page to apply this proposal."

## TASK-484 Dock and float shell — `apps/praxis-desktop/renderer/test/assistantShellMode.test.ts`

### PT-DAB2F1F6A7

Automation: **node:test**, [assistantShellMode.test.ts:23](../../apps/praxis-desktop/renderer/test/assistantShellMode.test.ts#L23).
Title: **the shell mode is two persisted booleans, defaulting to floating and closed**.

**Given** an empty store.
**When** shell mode is read, persisted docked+open, read, then persisted floating+closed.
**Then** it defaults to floating and closed, and the store holds exactly the two keys as `1`/`0`.

### PT-B25B27275D

Automation: **node:test**, [assistantShellMode.test.ts:33](../../apps/praxis-desktop/renderer/test/assistantShellMode.test.ts#L33).
Title: **a half-written store reads each key independently**.

**Given** a store holding only the docked key, and one holding only the open key.
**When** each is read.
**Then** each key is read on its own and the other defaults to false.

### PT-7A0843A5C7

Automation: **node:test**, [assistantShellMode.test.ts:38](../../apps/praxis-desktop/renderer/test/assistantShellMode.test.ts#L38).
Title: **each shell action moves only the flag it owns**.

**Given** seven action/state pairs (dock, float, toggleDock ×2, open, close, toggleOpen).
**When** `nextShellMode` applies each.
**Then** each changes only its own flag.

### PT-696C0C0697

Automation: **node:test**, [assistantShellMode.test.ts:53](../../apps/praxis-desktop/renderer/test/assistantShellMode.test.ts#L53).
Title: **dock↔float issues no assistant command and carries the open conversation through**.

**Given** an open shell showing `conv-1`, and one with no conversation.
**When** every shell action is applied.
**Then** no action issues an assistant command, `conv-1` stays open, and the empty shell gains no conversation. This proves the shell model; it does not observe main's execution owner (finding).

### PT-FFCB3D1974

Automation: **node:test**, [assistantShellMode.test.ts:72](../../apps/praxis-desktop/renderer/test/assistantShellMode.test.ts#L72).
Title: **docking then floating returns to the original shell state**.

**Given** a floating, open shell on `conv-1`.
**When** it docks and then floats.
**Then** the state equals the start.

## TASK-484 Submit command — `apps/praxis-desktop/renderer/test/assistantSubmitCommand.test.ts`

Snapshot `a1f5ecbbf28dfac0de20a85fcc4ee2c3757bec77`. `AssistantProvider.send` builds every new submission through `buildSubmitCommand`; a transport retry resends the recorded pending command instead.

### PT-7886057B66

Automation: **node:test**, [assistantSubmitCommand.test.ts:17](../../apps/praxis-desktop/renderer/test/assistantSubmitCommand.test.ts#L17).
Title: **a detached context submits one message with no context field at all**.

**Given** a send whose captured page context is `undefined` (detached, or nothing registered).
**When** `buildSubmitCommand` builds the command.
**Then** the command has no `context` key at all and still carries the text and command id. That the pill re-attaches for the next message is proven only by PT-450D784024 (`assistant.spec.ts:471`), not here.

### PT-4ACA5F1560

Automation: **node:test**, [assistantSubmitCommand.test.ts:24](../../apps/praxis-desktop/renderer/test/assistantSubmitCommand.test.ts#L24).
Title: **an attached context is captured as a copy navigation cannot change**.

**Given** a send carrying a live issue context for `TEAM-12`.
**When** the command is built and the live context object is then changed to `TEAM-99`.
**Then** the command still holds the original `TEAM-12` context.

### PT-E347BC137E

Automation: **node:test**, [assistantSubmitCommand.test.ts:32](../../apps/praxis-desktop/renderer/test/assistantSubmitCommand.test.ts#L32).
Title: **a mention travels verbatim so core can route it to that member**.

**Given** the text `@qa can you check the edge cases?` with members `dev` and `qa`.
**When** the command is built.
**Then** the text is unchanged and the participants are `part-dev`, `part-qa`. Routing the mention to `qa` is core's job and is not asserted here (finding).

### PT-475E27C815

Automation: **node:test**, [assistantSubmitCommand.test.ts:38](../../apps/praxis-desktop/renderer/test/assistantSubmitCommand.test.ts#L38).
Title: **the command targets the captured conversation and revision**.

**Given** a send captured for conversation `chat-7` at revision 12.
**When** the command is built.
**Then** it targets `chat-7` with expected revision 12.

### PT-E7F2147281

Automation: **node:test**, [assistantSubmitCommand.test.ts:44](../../apps/praxis-desktop/renderer/test/assistantSubmitCommand.test.ts#L44).
Title: **staged attachment refs are carried and copied, not aliased**.

**Given** one staged attachment ref.
**When** the command is built.
**Then** the command's refs equal the input but are a different array.

### PT-4BA238EE4B

Automation: **node:test**, [assistantSubmitCommand.test.ts:51](../../apps/praxis-desktop/renderer/test/assistantSubmitCommand.test.ts#L51).
Title: **only string runtime options cross the bridge**.

**Given** runtime options with string, number, boolean and undefined values.
**When** the command is built.
**Then** only `provider` and `model` (the strings) remain.
