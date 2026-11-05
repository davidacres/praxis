# FX-BE-183 renderer subscription and legacy migration contracts

Frozen snapshot: `622613fbed15edab22f77d4c2597e3bf784f1b4a`. Runner: **node:test**. These **16 supplemental cases** are 8 activation/repository cases, 3 migration cases, 3 coordinator cases and 2 renderer subscription cases. They sit outside the Playwright-only generator. IDs use SHA1(file + newline + exact title), the same rule as the catalog, and none collides with a catalog id.

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

Automation: **node:test**, [teamChatActivation.test.ts:89](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L89).
Title: **disabled activation never commits or fences unrelated legacy work**.

**Given** a TeamChatActivation constructed disabled.
**When** activation is requested and then a legacy call runs.
**Then** activation is rejected without committing, and the legacy call still returns its value.

### PT-63819EA534

Automation: **node:test**, [teamChatActivation.test.ts:97](../../apps/praxis-desktop/main/src/main/teamChatActivation.test.ts#L97).
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

Automation: **node:test**, [teamChatMigration.test.ts:39](../../packages/core/src/ai/assistant/teamChatMigration.test.ts#L39).
Title: **ambiguous legacy results remain diagnostics rather than invented successful attempts**.

**Given** a snapshot carrying an unbound legacy result diagnostic.
**When** it is migrated.
**Then** the diagnostic is kept as-is and the migrated conversation has no turns.

## Coordinator controls — `packages/core/src/ai/assistant/teamChatCoordinator.test.ts`

### PT-D81B94C6F4

Automation: **node:test**, [teamChatCoordinator.test.ts:636](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L636).
Title: **revisioned controls reject stale targets and persist idempotent command outcomes**.

**Given** a conversation with one decision message.
**When** a pin command is sent twice, re-sent with a different message id, sent as an unpin at the old revision, then as an unpin at the current revision.
**Then** the repeat returns the same revision with one receipt, the conflicting payload is rejected, the stale unpin leaves the pin, and the current unpin clears it.

### PT-824F86BCDF

Automation: **node:test**, [teamChatCoordinator.test.ts:656](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L656).
Title: **deletion during dispatch fences late results and never recreates a conversation**.

**Given** a turn whose execution is held open.
**When** the conversation is removed and the execution then returns a reply.
**Then** the conversation stays absent from the coordinator and the repository.

### PT-BCE1A74F9A

Automation: **node:test**, [teamChatCoordinator.test.ts:673](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L673).
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
